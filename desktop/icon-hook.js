// electron-builder afterPack: put Tandemi's icon and name into Tandemi.exe with plain JavaScript (resedit), so the
// installer can be built on Windows, macOS or Linux without extra tools.
'use strict';
const fs = require('fs');
const path = require('path');
exports.default = async function (ctx) {
  if (ctx.electronPlatformName !== 'win32') return;
  const ResEdit = require('resedit');
  const exe = path.join(ctx.appOutDir, `${ctx.packager.appInfo.productFilename}.exe`);
  const bin = ResEdit.NtExecutable.from(fs.readFileSync(exe), { ignoreCert: true });
  const res = ResEdit.NtExecutableResource.from(bin);
  const ico = ResEdit.Data.IconFile.from(fs.readFileSync(path.join(__dirname, 'icon.ico')));
  const groups = ResEdit.Resource.IconGroupEntry.fromEntries(res.entries);
  ResEdit.Resource.IconGroupEntry.replaceIconsForResource(res.entries, groups.length ? groups[0].id : 1, groups.length ? groups[0].lang : 1033, ico.icons.map(i => i.data));
  const vi = ResEdit.Resource.VersionInfo.fromEntries(res.entries)[0];
  if (vi) {
    const v = ctx.packager.appInfo.version.split('.').map(Number);
    vi.setFileVersion(v[0], v[1], v[2], 0); vi.setProductVersion(v[0], v[1], v[2], 0);
    for (const lang of vi.getAllLanguagesForStringValues()) vi.setStringValues(lang, { ProductName: 'Tandemi', FileDescription: 'Tandemi', CompanyName: 'Tandemi', OriginalFilename: 'Tandemi.exe', InternalName: 'Tandemi', LegalCopyright: 'Rati Shetsiruli' });
    vi.outputToResourceEntries(res.entries);
  }
  res.outputResource(bin);
  fs.writeFileSync(exe, Buffer.from(bin.generate()));
};
