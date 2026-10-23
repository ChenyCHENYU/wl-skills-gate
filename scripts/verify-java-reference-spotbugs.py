"""Owned primary SpotBugs source mapping, against an approved distribution."""
import argparse
import importlib.util
import json
from pathlib import Path
import sys
import tempfile
import xml.etree.ElementTree as ET
sys.dont_write_bytecode = True


def load(name, file):
    spec = importlib.util.spec_from_file_location(name, file)
    value = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(value)
    return value


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--home', required=True)
    parser.add_argument('--native-report')
    parser.add_argument('--repo')
    parser.add_argument('--modules')
    args = parser.parse_args()
    package = Path(__file__).resolve().parent.parent
    home = Path(args.home).resolve()
    load('distribution', package / 'scripts/java-distribution.py').verify(home, json.loads((package / 'assets/java-reference.lock.json').read_text())['files'])
    sys.path.insert(0, str(home / 'scripts'))
    spotbugs = load('approved_spotbugs', home / 'scripts/spotbugs.py')
    cases = []
    with tempfile.TemporaryDirectory(prefix='wl-spotbugs-primary-') as directory:
        repo = Path(directory)
        service = repo / 'service/src/main/java/org/example/Owner.java'
        entity = repo / 'entity/src/main/java/org/example/BaseDataRecord.java'
        duplicate = repo / 'second/src/main/java/org/example/Owner.java'
        for file in [service, entity, duplicate]:
            file.parent.mkdir(parents=True, exist_ok=True)
            file.write_text('package org.example; class %s {}\n' % file.stem)
        xml = '''<BugCollection version="4.10.4"><BugInstance type="BC_UNCONFIRMED_CAST">
<Class classname="org.example.Owner" primary="true"><SourceLine classname="org.example.Owner" sourcepath="org/example/Owner.java" start="1"/></Class>
<Type descriptor="Lorg/example/BaseDataRecord;" role="TYPE_FOUND"><SourceLine classname="org.example.BaseDataRecord" sourcepath="org/example/BaseDataRecord.java" start="1"/></Type>
<SourceLine classname="org.example.Owner" sourcepath="org/example/Owner.java" primary="true" start="42"/>
</BugInstance></BugCollection>'''

        def check(name, text=xml, modules=('service',), error=False):
            root = ET.fromstring(text)
            before = ET.tostring(root)
            failed = False
            try:
                result = spotbugs.resolve_source_map(root, [str(service), str(entity), str(duplicate)], str(repo), list(modules))
            except spotbugs.ScanError:
                failed = True
            assert failed is error, (name, failed, error)
            assert ET.tostring(root) == before, 'native metadata must not be removed or altered'
            if not failed:
                assert result == {'org/example/Owner.java': str(service)}
                assert spotbugs.primary_source_lines(next(root.iter('BugInstance')))[0].get('start') == ('8' if name == 'method-primary-fallback' else '42')
            cases.append({'case': name, 'status': 'passed'})

        check('external-type-reference-preserved-not-an-owned-mapping-error')
        check('two-owned-same-sourcepaths-rejected', modules=('service', 'second'), error=True)
        check('unknown-owned-primary-rejected', text=xml.replace('sourcepath="org/example/Owner.java" primary="true"', 'sourcepath="org/example/Missing.java" primary="true"'), error=True)
        check('external-primary-cannot-use-owned-secondary-to-pass', text=xml.replace('sourcepath="org/example/Owner.java" primary="true"', 'sourcepath="org/example/BaseDataRecord.java" primary="true"'), error=True)
        check('missing-native-primary-rejected', text=xml.replace(' primary="true"', ''), error=True)
        check('method-primary-fallback', text='''<BugCollection><BugInstance type="THROWS_METHOD_THROWS_CLAUSE_BASIC_EXCEPTION"><Method primary="true"><SourceLine classname="org.example.Owner" sourcepath="org/example/Owner.java" start="8"/></Method><Type role="TYPE_FOUND"><SourceLine classname="org.example.BaseDataRecord" sourcepath="org/example/BaseDataRecord.java"/></Type></BugInstance></BugCollection>''')
        check('unknown-owned-secondary-cannot-be-silently-dropped', text=xml.replace('</BugInstance>', '<Method><SourceLine classname="org.example.Owner" sourcepath="org/example/Missing.java"/></Method></BugInstance>'), error=True)
    actual = None
    if args.native_report:
        assert args.repo and args.modules
        root = ET.parse(args.native_report).getroot()
        mapped = spotbugs.resolve_source_map(root, spotbugs.collect_java(args.repo, []), args.repo, args.modules.split(','))
        bugs = list(root.iter('BugInstance'))
        assert all(spotbugs.primary_source_lines(bug) for bug in bugs)
        actual = {'report': args.native_report, 'nativeBugs': len(bugs), 'mappedOwnedFiles': len(mapped), 'complete': True}
    print(json.dumps({'status': 'passed', 'tests': len(cases), 'results': cases, 'nativeEvidence': actual}, ensure_ascii=False))


if __name__ == '__main__':
    main()
