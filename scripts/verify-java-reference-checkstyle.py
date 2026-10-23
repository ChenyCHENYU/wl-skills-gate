"""Regression checks against the exact approved Java distribution, no network."""
import argparse
import importlib.util
import json
from pathlib import Path
import subprocess
import sys
import tempfile
from types import SimpleNamespace
from unittest.mock import patch
import xml.etree.ElementTree as ET
sys.dont_write_bytecode = True


def module(name, file):
    spec = importlib.util.spec_from_file_location(name, file)
    value = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(value)
    return value


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--home', required=True)
    args = parser.parse_args()
    package = Path(__file__).resolve().parent.parent
    home = Path(args.home).resolve()
    lock = json.loads((package / 'assets/java-reference.lock.json').read_text())
    installer = module('distribution', package / 'scripts/java-distribution.py')
    installer.verify(home, lock['files'])
    sys.path.insert(0, str(home / 'scripts'))
    scan = module('fixed_scan', home / 'scripts/scan.py')
    results = []

    def case(name, fn):
        fn()
        results.append({'case': name, 'status': 'passed'})

    def simulated(message, source='com.puppycrawl.tools.checkstyle.checks.javadoc.MissingJavadocMethodCheck',
                  stderr=b'', malformed=False, returncode=1, expected_error=False, count=1):
        with tempfile.TemporaryDirectory(prefix='wl-checkstyle-regression-') as directory:
            root = Path(directory)
            files = []
            for index in range(count):
                file = root / ('Example%s.java' % index)
                file.write_text('class Example%s {}\n' % index)
                files.append(str(file))
            out = root / 'reports'
            out.mkdir()

            def execute(argv, **_):
                file = Path(argv[argv.index('-o') + 1])
                if malformed:
                    file.write_text('<checkstyle><broken')
                else:
                    xml = ET.Element('checkstyle', {'version': '10.9.3'})
                    for value in argv[argv.index('-o') + 2:]:
                        parent = ET.SubElement(xml, 'file', {'name': value})
                        ET.SubElement(parent, 'error', {'line': '1', 'severity': 'error', 'message': message, 'source': source})
                    ET.ElementTree(xml).write(file, encoding='UTF-8', xml_declaration=True)
                current = returncode
                if count > 1:
                    current = len(argv[argv.index('-o') + 2:]) % 256
                return SimpleNamespace(returncode=current, stdout=b'', stderr=stderr)

            failed = False
            with patch.object(scan.subprocess, 'run', side_effect=execute):
                try:
                    codes = scan.do_checkstyle('/fake/java', files, str(out))
                except (scan.ScanError, ET.ParseError):
                    failed = True
            assert failed is expected_error, (message, expected_error, failed)
            assert not (out / '.cs-chunks').exists(), 'chunk cleanup must complete on success/failure'
            if not failed:
                tree = ET.parse(out / 'checkstyle.xml')
                observed = tree.getroot().findall('.//error')
                assert len(observed) == count
                assert all(error.get('message') == message for error in observed)
                assert len(codes) == (count + 119) // 120

    case('ordinary-missing-javadoc-throws-runtimeexception', lambda: simulated("Expected @throws tag for 'RuntimeException'."))
    case('ordinary-illegalthrows-runtimeexception', lambda: simulated("禁止抛出： 'RuntimeException' 。", source='com.puppycrawl.tools.checkstyle.checks.coding.IllegalThrowsCheck'))
    case('ordinary-exception-naming-rule', lambda: simulated("Name 'BusinessException' must match pattern.", source='com.example.ExceptionNamingCheck'))
    case('actual-checkstyleexception-rejected', lambda: simulated('com.puppycrawl.tools.checkstyle.api.CheckstyleException: malformed', expected_error=True))
    case('actual-error-processing-rejected', lambda: simulated('Error processing source file', expected_error=True))
    case('actual-exception-thrown-rejected', lambda: simulated('Exception was thrown while processing Example.java', expected_error=True))
    case('actual-exception-prefix-rejected', lambda: simulated('Exception: java.lang.IllegalStateException', expected_error=True))
    case('actual-stderr-diagnostic-rejected', lambda: simulated('ordinary violation', stderr=b'CheckstyleException: parse failed', expected_error=True))
    case('malformed-xml-rejected', lambda: simulated('ordinary violation', malformed=True, expected_error=True))
    case('mismatched-exit-count-rejected', lambda: simulated('ordinary violation', returncode=2, expected_error=True))
    case('all-chunks-preserve-ordinary-exception-violations', lambda: simulated("Expected @throws tag for 'RuntimeException'.", count=121))

    def real_checkstyle():
        with tempfile.TemporaryDirectory(prefix='wl-checkstyle-real-') as directory:
            root = Path(directory)
            source = root / 'Example.java'
            source.write_text('''package example;
/** Example. */
public class Example {
    /** Run. */
    public void run() throws RuntimeException {
        throw new RuntimeException("demo");
    }
}
''')
            out = root / 'reports'
            out.mkdir()
            java = scan.resolve_java(None)
            scan.do_checkstyle(java, [str(source)], str(out))
            findings = ET.parse(out / 'checkstyle.xml').getroot().findall('.//error')
            assert any('RuntimeException' in error.get('message', '') for error in findings), findings
    case('real-java21-checkstyle10-ordinary-runtimeexception-preserved', real_checkstyle)
    print(json.dumps({'status': 'passed', 'distribution': str(home), 'tests': len(results), 'results': results}, ensure_ascii=False))


if __name__ == '__main__':
    main()
