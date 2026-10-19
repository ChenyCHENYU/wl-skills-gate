"""Build/install the exact offline Java distribution pinned by Gate. No pip or AI."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import shutil
import tempfile
import zipfile

LOCK = Path(__file__).resolve().parent.parent / 'assets/java-reference.lock.json'


def digest(data):
    return hashlib.sha256(data).hexdigest()


def verify(root, rows):
    root = Path(root).resolve()
    expected = {row['path'] for row in rows}
    actual = set()
    for folder in ['scripts', 'config', 'tools', 'LICENSES']:
        for directory, directories, filenames in os.walk(root / folder):
            for child in directories:
                if (Path(directory) / child).is_symlink():
                    raise ValueError('distribution directory symlink')
            directories[:] = [child for child in directories if child != '__pycache__']
            for name in filenames:
                if name == '.DS_Store' or name.endswith('.pyc'):
                    continue
                actual.add((Path(directory) / name).relative_to(root).as_posix())
    if actual != expected:
        raise ValueError('distribution inventory changed (extra/missing runtime file)')
    for row in rows:
        relative = Path(row['path'])
        if relative.is_absolute() or '..' in relative.parts:
            raise ValueError('invalid distribution path')
        file = root / relative
        current = file
        while current != root:
            if current.is_symlink():
                raise ValueError('distribution symlink: ' + row['path'])
            current = current.parent
        data = file.read_bytes()
        if len(data) != row['bytes'] or digest(data) != row['sha256']:
            raise ValueError('distribution hash mismatch: ' + row['path'])


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('action', choices=['pack', 'install', 'verify'])
    parser.add_argument('--directory', required=True)
    parser.add_argument('--archive')
    args = parser.parse_args()
    lock_bytes = LOCK.read_bytes()
    rows = json.loads(lock_bytes)['files']
    directory = Path(args.directory).absolute()
    if directory.is_symlink():
        raise ValueError('distribution root symlink')
    if args.action == 'pack':
        verify(directory, rows)
        if not args.archive:
            raise ValueError('archive required')
        archive = Path(args.archive).absolute()
        if archive.exists():
            raise ValueError('archive already exists')
        archive.parent.mkdir(parents=True, exist_ok=True)
        with zipfile.ZipFile(archive, 'x', compression=zipfile.ZIP_DEFLATED) as target:
            for row in rows:
                # Fixed metadata makes the handoff reproducible.
                item = zipfile.ZipInfo(row['path'], date_time=(2026, 1, 1, 0, 0, 0))
                item.compress_type = zipfile.ZIP_DEFLATED
                target.writestr(item, (directory / row['path']).read_bytes())
    elif args.action == 'install':
        if not args.archive:
            raise ValueError('archive required')
        directory.parent.mkdir(parents=True, exist_ok=True)
        if directory.exists():
            verify(directory, rows)
        else:
            temporary = Path(tempfile.mkdtemp(prefix='.wl-java-', dir=directory.parent))
            try:
                with zipfile.ZipFile(args.archive) as archive:
                    entries = archive.infolist()
                    expected = {row['path']: row for row in rows}
                    if len(entries) != len(expected) or {x.filename for x in entries} != set(expected):
                        raise ValueError('archive inventory mismatch')
                    for entry in entries:
                        row = expected[entry.filename]
                        if entry.file_size != row['bytes'] or entry.flag_bits & 1:
                            raise ValueError('archive size/encryption mismatch')
                        # Never use extractall: write only the approved regular files.
                        data = archive.read(entry)
                        if digest(data) != row['sha256']:
                            raise ValueError('archive hash mismatch: ' + entry.filename)
                        file = temporary / row['path']
                        file.parent.mkdir(parents=True, exist_ok=True)
                        file.write_bytes(data)
                verify(temporary, rows)
                try:
                    os.rename(temporary, directory)
                except OSError:
                    if not directory.exists():
                        raise
                    verify(directory, rows)
            finally:
                if temporary.exists():
                    shutil.rmtree(temporary)
    else:
        verify(directory, rows)
    print(json.dumps({'status': 'verified', 'version': '1.1.0', 'files': len(rows),
                      'lockSha256': digest(lock_bytes)}, separators=(',', ':')))


if __name__ == '__main__':
    main()
