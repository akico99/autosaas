'use strict';

// Manual public-page smoke check. Run with Electron, never as part of npm test.
// Uses temporary userData/catalog and does not generate a post or call a writing model.
const { app, BrowserWindow, session } = require('electron');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createShortlinkResolver } = require('../electron/shortlinkResolver');
const { createTravelProductImporter } = require('../src/connect/productImport');
const { buildAutoImportSave, deriveSeedKeywords } = require('../src/connect/autoPipeline');
const { createConnectService } = require('../src/connect/service');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'autosaas-live-import-'));
app.setPath('userData', path.join(temp, 'profile'));
const url = process.argv.find((value) => /^https:\/\//.test(value));
const watchdog = setTimeout(() => app.exit(1), 45000);
app.whenReady().then(async () => {
  const keepAlive = new BrowserWindow({ show: false });
  try {
    if (!url) throw new Error('Pass an issued HTTPS link as an argument.');
    const importer = createTravelProductImporter({ resolveUrl: createShortlinkResolver({ BrowserWindow, session }) });
    const result = await importer({ url });
    if (!result.ok) throw new Error(result.error);
    const catalogFile = path.join(temp, 'catalog.json');
    // Optional read-only snapshot of existing registration, to validate legacy repair.
    if (process.env.CONNECT_VALIDATE_LEGACY === '1') fs.copyFileSync(path.join(process.env.APPDATA, 'blog-auto', 'connect', 'catalog.json'), catalogFile);
    const service = createConnectService({ catalogFile });
    const previous = service.catalog().products.find((product) => product.affiliateUrlRaw === url);
    const built = buildAutoImportSave({ imported: result.imported, catalog: service.catalog() });
    if (!built.ok) throw new Error(built.error);
    const saved = service.saveProduct({ product: built.product, sources: built.sources });
    const selected = saved.product.variants.filter((variant) => built.variantIds.includes(variant.id));
    if (previous && previous.variants.some((variant) => !built.variantIds.includes(variant.id))) throw new Error('Previously selected option could not be reused.');
    if (saved.product.eligibility !== 'verified' || !selected.length) throw new Error('Missing verified link or selected options.');
    for (const variant of selected) {
      if (!saved.product.facts.some((fact) => fact.field === 'variant:' + variant.id + ':price' && fact.status === 'verified')) throw new Error('Missing verified option price: ' + variant.id);
    }
    process.stdout.write('AUTO_IMPORT_RESULT ' + JSON.stringify({ ok: true, repairedLegacyRegistration: !!previous, previousEligibility: previous && previous.eligibility, chain: result.imported.resolution.chain, name: saved.product.name, detailUrl: saved.product.detailUrl, issuedUrl: saved.product.affiliateUrlRaw, eligibility: saved.product.eligibility, prices: selected.map((variant) => ({ options: variant.options, amountMinor: variant.amountMinor, departureDate: variant.departureDate })), seeds: deriveSeedKeywords(saved.product), savedProducts: service.catalog().products.length }) + '\n');
    process.exitCode = 0;
  } catch (error) {
    process.stderr.write('AUTO_IMPORT_FAILED ' + error.message + '\n');
    process.exitCode = 1;
  } finally {
    clearTimeout(watchdog);
    keepAlive.destroy();
    app.exit(process.exitCode || 0);
  }
});
