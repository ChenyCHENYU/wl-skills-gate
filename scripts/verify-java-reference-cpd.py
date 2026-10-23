import argparse, importlib.util, json, pathlib, sys
sys.dont_write_bytecode = True
import xml.etree.ElementTree as ET
p=argparse.ArgumentParser();p.add_argument('--home',required=True);p.add_argument('--raw');a=p.parse_args()
sys.path.insert(0,str(pathlib.Path(a.home)/'scripts'))
spec=importlib.util.spec_from_file_location('fixed_make_report',pathlib.Path(a.home)/'scripts/make_report.py');m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
rows={'A.java':{'lines':243},'B.java':{'lines':345}}
def location(line='227',end='243'):
 x=ET.Element('file',{'path':'A.java','line':line})
 if end is not None:x.set('endline',end)
 return x
assert m.cpd_interval(location(),19,rows,lambda p:p)==('A.java',227,243)
assert m.cpd_interval(location('225',None),19,rows,lambda p:p)==('A.java',225,243)
for end in ['0','226','244','2.5','2e2','', '-1']:
 try:m.cpd_interval(location(end=end),19,rows,lambda p:p)
 except m.ScanError:pass
 else:raise AssertionError('invalid endline accepted: '+end)
result={'status':'passed','tests':9,'endlineFirst':True,'missingEndlineFallback':True}
if a.raw:
 root=pathlib.Path(a.raw);manifest=json.loads((root/'scan-manifest.json').read_text());source={r['path']:r for r in manifest['scope']['source']['files']};repo=manifest['repo'].replace('\\','/');ranges={};locations=0
 def relative(p):
  p=(p or '').replace('\\','/');return p[len(repo)+1:] if p.startswith(repo+'/') else p
 for block in ET.parse(root/'cpd.xml').getroot().iter('duplication'):
  for entry in block.iter('file'):
   name,start,stop=m.cpd_interval(entry,int(block.get('lines')),source,relative);ranges.setdefault(name,[]).append((start,stop));locations+=1
 total=0
 for entries in ranges.values():
  end=0
  for start,stop in sorted(entries):total+=max(0,stop-max(end,start-1));end=max(end,stop)
 result.update(realLocations=locations,duplicateLines=total)
print(json.dumps(result))
