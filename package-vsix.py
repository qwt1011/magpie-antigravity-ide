"""Package the local extension using only Python's standard library."""
from pathlib import Path
from zipfile import ZipFile, ZIP_DEFLATED
from xml.etree import ElementTree as ET
import json

root = Path(__file__).resolve().parent
source = root / 'extension'
m = json.loads((source / 'package.json').read_text(encoding='utf-8'))
ns = 'http://schemas.microsoft.com/developer/vsx-schema/2011'
ET.register_namespace('', ns)
def node(parent, name, text=None, **attrs):
    el = ET.SubElement(parent, '{%s}%s' % (ns, name), attrs)
    el.text = text
    return el

manifest = ET.Element('{%s}PackageManifest' % ns, Version='2.0.0')
meta = node(manifest, 'Metadata')
node(meta, 'Identity', Language='zh-CN', Id=m['name'], Version=m['version'], Publisher=m['publisher'])
node(meta, 'DisplayName', m['displayName'])
node(meta, 'Description', m['description'])
props = node(meta, 'Properties')
node(props, 'Property', Id='Microsoft.VisualStudio.Code.Engine', Value=m['engines']['vscode'])
node(props, 'Property', Id='Microsoft.VisualStudio.Code.ExtensionKind', Value=','.join(m['extensionKind']))
node(node(manifest, 'Installation'), 'InstallationTarget', Id='Microsoft.VisualStudio.Code')
node(manifest, 'Dependencies')
assets = node(manifest, 'Assets')
node(assets, 'Asset', Type='Microsoft.VisualStudio.Code.Manifest', Path='extension/package.json', Addressable='true')
node(assets, 'Asset', Type='Microsoft.VisualStudio.Services.Content.Details', Path='extension/README.md', Addressable='true')
node(assets, 'Asset', Type='Microsoft.VisualStudio.Services.Content.License', Path='extension/LICENSE', Addressable='true')
types = ET.Element('Types', xmlns='http://schemas.openxmlformats.org/package/2006/content-types')
for ext, mime in {'json':'application/json','cjs':'application/javascript','md':'text/markdown','vsixmanifest':'text/xml'}.items():
    ET.SubElement(types, 'Default', Extension=ext, ContentType=mime)
out = root / '.local' / 'artifacts' / f"{m['name']}-{m['version']}.vsix"
out.parent.mkdir(parents=True, exist_ok=True)
with ZipFile(out, 'w', compression=ZIP_DEFLATED) as z:
    z.writestr('extension.vsixmanifest', ET.tostring(manifest, encoding='utf-8', xml_declaration=True))
    z.writestr('[Content_Types].xml', ET.tostring(types, encoding='utf-8', xml_declaration=True))
    for f in (source/'package.json', source/'extension.cjs', root/'README.md', root/'native-profile.cjs', root/'cli-session.cjs'):
        z.write(f, 'extension/' + f.name)
    z.write(root/'LICENSE', 'extension/LICENSE')
    z.write(root/'NOTICE', 'extension/NOTICE')
print(out)
