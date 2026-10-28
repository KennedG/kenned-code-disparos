'use strict';

// Executes the shipped navigation renderer. Desktop visibility and real width
// are checked separately by scripts/smoke-ui.cjs.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const expected = ['dashboard', 'campaigns', 'sources', 'buscas', 'groups', 'settings', 'license'];

function fixture() {
  const context = vm.createContext({ window: {} });
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../src/ui/navigation.js'), 'utf8'), context);
  const nav = context.window.KennedNavigation;
  return { nav, render: options => nav.render({ canPage: () => true, page: 'dashboard', ...options }) };
}
const buttons = html => [...html.matchAll(/<button\b[^>]*data-action="navigate"[^>]*>[\s\S]*?<\/button>/g)].map(match => match[0]);
const ids = html => buttons(html).filter(button => button.includes('data-nav-main')).map(button => button.match(/data-id="([^"]+)"/)[1]);

test('navigation renders exactly seven ordered primary entries and hides existing tools by default', () => {
  const f = fixture(), html = f.render();
  assert.deepEqual(Array.from(f.nav.primary), expected); assert.deepEqual(ids(html), expected);
  assert.match(html, /id="nav-extra-tools" hidden/); assert.match(html, /data-action="toggle-more-tools" aria-expanded="false"/);
  for (const name of ['Painel', 'Campanhas', 'Origem da loja', 'Buscas', 'Grupos', 'Configurações', 'Licença']) assert.match(html, new RegExp(`>${name}<`));
});

test('expanded tools contain actual modules grouped by subject and no sales or financial modules', () => {
  const html = fixture().render({ moreTools: true });
  assert.match(html, /id="nav-extra-tools">/); assert.match(html, /aria-expanded="true"/);
  for (const category of ['Atendimento', 'Conteúdo', 'Automação', 'Diagnóstico', 'Administração']) assert.match(html, new RegExp(`<h3>${category}</h3>`));
  for (const id of ['opportunities', 'contacts', 'library', 'alerts', 'reminders', 'history', 'diagnostics', 'reports', 'users']) assert.match(html, new RegExp(`data-id="${id}"[^>]*data-nav-extra`));
  assert.match(html, /data-library-tab="templates"/); assert.match(html, /data-library-tab="media"/);
  assert.doesNotMatch(html, /data-id="(?:sales|cash|finance|inventory|margins)"|Financeiro|Vendas|Caixa|Estoque/);
});

test('navigation permissions remove unauthorized modules and empty categories', () => {
  const html = fixture().render({ canPage: id => ['dashboard', 'license', 'contacts'].includes(id) });
  assert.deepEqual(ids(html), ['dashboard', 'license']);
  assert.match(html, /<h3>Atendimento<\/h3>/); assert.match(html, /data-id="contacts"/);
  assert.doesNotMatch(html, /data-id="opportunities"|<h3>Conteúdo<\/h3>|<h3>Automação<\/h3>|<h3>Diagnóstico<\/h3>|<h3>Administração<\/h3>/);
});

test('confirmed expiry shows six locked primary entries and only enabled license without tools', () => {
  const html = fixture().render({ expired: true, page: 'license', moreTools: true, canPage: () => false });
  assert.deepEqual(ids(html), expected); const all = buttons(html); assert.equal(all.length, 7);
  for (const button of all) {
    if (button.includes('data-id="license"')) { assert.doesNotMatch(button, /\bdisabled\b|data-license-locked/); assert.match(button, /aria-current="page"/); }
    else { assert.match(button, /data-license-locked/); assert.match(button, / disabled aria-disabled="true"/); assert.match(button, /<svg[^>]*><rect[^>]*\/><path/); }
  }
  assert.doesNotMatch(html, /toggle-more-tools|nav-extra-tools|data-nav-extra|nav-count/);
});

test('primary icon buttons retain explanatory titles, accessible names and current-page marker', () => {
  const html = fixture().render({ page: 'groups' });
  const primary = buttons(html).filter(button => button.includes('data-nav-main'));
  assert.equal(primary.filter(button => /aria-current="page"/.test(button)).length, 1);
  assert.match(primary.find(button => button.includes('data-id="groups"')), /aria-current="page"/);
  for (const button of primary) { assert.match(button, /title="[^"]+"/); assert.match(button, /aria-label="[^"]+"/); assert.match(button, /class="nav-icon" aria-hidden="true"/); }
});

test('untrusted page and counter values cannot inject executable markup in navigation', () => {
  const html = fixture().render({ page: '\"><img src=x onerror=alert(1)>', campaignCount: '<script>unsafe()</script>' });
  assert.doesNotMatch(html, /<img|<script|onerror=|unsafe\(\)/); assert.doesNotMatch(html, /aria-current="page"/);
});

test('content navigation highlights only the selected library tab',()=>{
  const code=fs.readFileSync(path.join(__dirname,'../src/ui/navigation.js'),'utf8'),context=vm.createContext({window:{}});vm.runInContext(code,context);
  const html=context.window.KennedNavigation.render({canPage:()=>true,page:'library',moreTools:true,libraryTab:'templates'});
  const selected=[...html.matchAll(/<button[^>]*aria-current="page"[^>]*>/g)].map(x=>x[0]);
  assert.equal(selected.length,1);assert.match(selected[0],/data-library-tab="templates"/);
});
