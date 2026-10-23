// Version identity excludes host-specific paths/OS while keeping exact tool and
// compiler versions. Original output belongs in execution evidence, not policy.
export function stableToolVersion(command, output) {
  const raw=String(output||'').replace(/\x1b\[[0-9;]*m/g,'').trim();
  if(String(command||'').trim()!=='mvn -version')return raw;
  if(/^Apache Maven \S+ \| Java \S+$/.test(raw))return raw;
  const maven=raw.match(/^Apache Maven\s+([\w.+-]+)/m),java=raw.match(/^Java version:\s*([^,\s]+)/m);
  return maven&&java?`Apache Maven ${maven[1]} | Java ${java[1]}`:raw;
}
