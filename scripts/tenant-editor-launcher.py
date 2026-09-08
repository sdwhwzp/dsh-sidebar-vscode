#!/usr/bin/python3 -I
"""Fixed sudo launcher: isolated editor, one tenant mount, private Unix socket, filtered network."""
import fcntl
import grp
import json
import os
import pathlib
import pwd
import re
import sys

CONFIG = pathlib.Path('/etc/dsh-vsceditor.json')
# The sandbox shares the host network namespace so git reaches its remotes; the
# nftables table dsh_sandbox filters by this group, which must be the process
# group of every sandboxed editor.
SANDBOX_GROUP = 'dsh-sandbox'
# Per-account home, shared with the terminal sandbox and addressed by account id
# rather than tenant directory name so both reach the same one. Kept out of the
# workspace and out of the editor state: a version manager's downloads belong
# beside neither the account's code nor the workbench's own files.
HOME_ROOT = pathlib.Path('/var/lib/dsh-sandbox-home')
# Resolver, CA bundle and account lookups the network needs; /etc is otherwise empty.
NETWORK_FILES = ['/etc/resolv.conf', '/etc/hosts', '/etc/nsswitch.conf', '/etc/passwd', '/etc/group']


def trusted(path):
    """Root-owned deployment inputs and their ancestors cannot be user-writable."""
    path = pathlib.Path(path)
    if path.resolve(strict=True) != path:
        raise ValueError('noncanonical deployment path')
    for item in [path, *path.parents]:
        info = item.stat()
        if info.st_uid != 0 or info.st_mode & 0o022:
            raise ValueError('untrusted deployment path')
    return path


def sandbox_home(owner, account):
    """Create this account's sandbox home under a root-owned parent and return it."""
    if HOME_ROOT.exists():
        if HOME_ROOT.resolve(strict=True) != HOME_ROOT:
            raise ValueError('noncanonical home root')
        info = HOME_ROOT.stat()
        if info.st_uid != 0 or info.st_mode & 0o022:
            raise ValueError('untrusted home root')
    else:
        HOME_ROOT.mkdir(mode=0o711)
        os.chown(HOME_ROOT, 0, 0)
    home = HOME_ROOT / ('u' + owner)
    if not home.exists():
        home.mkdir(mode=0o700)
        os.chown(home, account.pw_uid, account.pw_gid)
    if home.resolve(strict=True) != home:
        raise ValueError('noncanonical account home')
    # `~/workspace` keeps the habit of reaching the workspace from the home.
    link = home / 'workspace'
    if not link.exists(follow_symlinks=False):
        link.symlink_to('/workspace')
    return home


def main():
    if os.geteuid() != 0 or len(sys.argv) != 3 or not re.fullmatch(r'[1-9][0-9]{0,15}', sys.argv[1]):
        raise ValueError('invalid invocation')
    owner, name = sys.argv[1:]
    if not re.fullmatch(r'(?:u' + owner + r'(?:-[a-f0-9]{12})?|admin-u' + owner + r')', name):
        raise ValueError('invalid tenant')
    config = json.loads(trusted(CONFIG).read_text())
    root = pathlib.Path(config['workspaceRoot'])
    if root.resolve(strict=True) != root:
        raise ValueError('invalid workspace root')
    tenant = root / name
    if tenant.resolve(strict=True) != tenant or not tenant.is_dir():
        raise ValueError('invalid tenant directory')
    runtime = trusted(config['codeServerRoot'])
    state_root = trusted(config['stateRoot'])
    account = pwd.getpwnam(config['account'])
    state = state_root / name
    if not state.exists():
        state.mkdir(mode=0o710)
        os.chown(state, 0, account.pw_gid)
    trusted(state)
    # The supervisor holds the lock outside the sandbox so an editor cannot release it.
    lock = os.open(state / 'launch.lock', os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600)
    fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
    data = state / 'data'
    run = state / 'run'
    for directory in [data, run]:
        if not directory.exists():
            directory.mkdir(mode=0o700)
            os.chown(directory, account.pw_uid, account.pw_gid)
        if directory.resolve(strict=True) != directory:
            raise ValueError('invalid runtime directory')
    socket = run / 'editor.sock'
    if socket.is_symlink():
        raise ValueError('invalid editor socket')
    socket.unlink(missing_ok=True)
    sandbox = grp.getgrnam(SANDBOX_GROUP)
    home = sandbox_home(owner, account)
    network = []
    for item in NETWORK_FILES:
        if pathlib.Path(item).exists():
            network += ['--ro-bind', item, item]
    args = ['/usr/bin/bwrap', '--unshare-ipc', '--unshare-pid', '--unshare-uts', '--unshare-cgroup-try', '--die-with-parent', '--clearenv',
            '--ro-bind', '/usr', '/usr', '--symlink', 'usr/bin', '/bin', '--symlink', 'usr/sbin', '/sbin', '--symlink', 'usr/lib', '/lib', '--symlink', 'usr/lib64', '/lib64',
            '--proc', '/proc', '--dev', '/dev', '--perms', '1777', '--tmpfs', '/tmp', '--perms', '0755', '--dir', '/etc', '--perms', '0755', '--dir', '/opt', '--perms', '0755', '--dir', '/run',
            # bwrap creates a missing bind parent as 0700 root, which the
            # dropped uid cannot traverse; the home mount needs it walkable.
            '--perms', '0755', '--dir', '/home',
            '--ro-bind', '/etc/ssl', '/etc/ssl', *network,
            '--ro-bind', str(runtime), '/opt/code-server', '--bind', str(tenant), '/workspace', '--bind', str(data), '/editor-data', '--bind', str(run), '/run/editor',
            '--bind', str(home), '/home/dsh', '--chdir', '/workspace',
            '--setenv', 'HOME', '/home/dsh', '--setenv', 'PATH', '/opt/code-server/lib/node:/usr/bin:/bin', '--setenv', 'LANG', 'C.UTF-8', '--setenv', 'TMPDIR', '/tmp',
            # The sandbox has a private /tmp, so the companion sidebar plugin's
            # command spool is addressed inside this account's editor state.
            '--setenv', 'DSH_SIDEBAR_VSCODE_SPOOL', '/editor-data/dsh-sidebar-vscode',
            '--', '/usr/bin/setpriv', '--reuid', str(account.pw_uid), '--regid', str(sandbox.gr_gid), '--clear-groups', '--no-new-privs', '--bounding-set=-all',
            '/opt/code-server/bin/code-server', '--auth', 'none', '--socket', '/run/editor/editor.sock', '--socket-mode', '0600', '--disable-telemetry', '--disable-update-check', '--disable-proxy',
            '--user-data-dir', '/editor-data/user', '--extensions-dir', '/editor-data/extensions', '--config', '/editor-data/config.yaml', '/workspace']
    # Keep the privileged parent outside the sandbox only to hold the launch lock.
    import subprocess
    import signal
    child = subprocess.Popen(args, env={'PATH': '/usr/bin:/bin', 'LANG': 'C.UTF-8'})
    def stop(_signum, _frame):
        child.terminate()
    signal.signal(signal.SIGTERM, stop)
    signal.signal(signal.SIGINT, stop)
    sys.exit(child.wait())


if __name__ == '__main__':
    try:
        main()
    except (ValueError, OSError, KeyError):
        sys.stderr.write('workspace editor: access denied or sandbox unavailable\n')
        sys.exit(1)
