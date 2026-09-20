import { expect,test } from '@playwright/test';
import { makeProtectedConnectionsFixture as fixture } from './admin-ui.fixture.mjs';

async function open(page,f){await page.route('**/api/admin/**',f.route);await page.goto('/');await expect(page.getByRole('button',{name:'Search',exact:true})).toBeVisible();if(await page.getByRole('button',{name:'Menu',exact:true}).isVisible())await page.getByRole('button',{name:'Menu',exact:true}).click();await page.getByRole('navigation',{name:'Main navigation'}).getByRole('link',{name:'Customers',exact:true}).click();await expect(page.getByRole('region',{name:'Customers',exact:true})).toContainText('Acme Corp');if(await page.locator('#customer-open-cus_acme').isVisible())await page.locator('#customer-open-cus_acme').click();else await page.getByRole('article').filter({has:page.getByRole('heading',{name:'Acme Corp',exact:true})}).getByRole('button',{name:'Open details'}).click();await expect(page.getByRole('heading',{name:'Protected connections',exact:true})).toBeVisible();}
const region=page=>page.getByRole('region',{name:'Protected connections'});

test("admin connections retire with explicit hold, exact request and audit history",async({page},testInfo)=>{
  const f=fixture();await open(page,f);
  await expect(region(page)).toContainText('Design workstation');await region(page).screenshot({path:testInfo.outputPath('connections-desktop.png')});
  await region(page).getByRole('button',{name:'Retire connection',exact:true}).click();
  const dialog=page.getByRole('dialog');await expect(dialog).toContainText('Existing signed offline access');await expect(dialog).toContainText('cus_acme');
  await dialog.getByRole('button',{name:'Retire connection',exact:true}).evaluate(button=>{button.click();button.click();});
  await expect(dialog).not.toBeVisible();await expect(region(page)).toContainText('Renewal stopped for Design workstation');
  expect(f.posts).toHaveLength(1);expect(JSON.parse(f.posts[0].body)).toEqual({expected_revision:0});expect(f.posts[0].key).toMatch(/^[A-Za-z0-9_-]{43}$/);
  await expect(region(page).getByRole('heading',{name:'Protected connections',exact:true})).toBeFocused();
  await region(page).getByText('History',{exact:true}).click();await expect(region(page)).toContainText('operator:access:operator-one');
});

test("admin connections recover a lost response after reload using the original operator and key",async({page})=>{
  const f=fixture();f.behavior.drop=true;await open(page,f);
  await region(page).getByRole('button',{name:'Retire connection',exact:true}).click();await page.getByRole('dialog').getByRole('button',{name:'Retire connection',exact:true}).click();
  await expect(page.getByRole('dialog')).toContainText('result is not confirmed');await expect(page.getByRole('dialog').getByRole('button',{name:'Review current connection'})).toHaveCount(0);await page.reload();
  await page.getByRole('navigation',{name:'Main navigation'}).getByRole('link',{name:'Customers',exact:true}).click();await page.locator('#customer-open-cus_acme').click();
  await region(page).getByRole('button',{name:'Review saved request'}).click();await page.getByRole('dialog').getByRole('button',{name:'Retry same request'}).click();
  await expect(page.getByRole('dialog')).not.toBeVisible();expect(f.posts).toHaveLength(2);expect(f.posts[1]).toEqual(f.posts[0]);
});

test("admin connections let a changed reader review and clear without another retirement",async({page})=>{
  const f=fixture();f.behavior.drop=true;await open(page,f);
  await region(page).getByRole('button',{name:'Retire connection',exact:true}).click();await page.getByRole('dialog').getByRole('button',{name:'Retire connection',exact:true}).click();
  await expect(page.getByRole('dialog')).toContainText('result is not confirmed');await page.getByRole('dialog').getByRole('button',{name:'Close',exact:true}).click();
  f.behavior.role='reader';f.behavior.subject='reader-two';await region(page).getByRole('button',{name:'Refresh connections'}).click();
  await region(page).getByRole('button',{name:'Review saved request'}).click();const dialog=page.getByRole('dialog');await expect(dialog.getByRole('button',{name:'Retry same request'})).toBeDisabled();
  await dialog.getByRole('button',{name:'Review current connection'}).click();await expect(dialog).toContainText('Current connection: retiring');
  await dialog.getByRole('button',{name:'Clear reviewed request'}).click();expect(f.posts).toHaveLength(1);await expect(region(page).getByRole('button',{name:'Retire connection',exact:true})).toHaveCount(0);
});

test("admin connections block a write when durable tab storage is unavailable",async({page})=>{
  const f=fixture();await open(page,f);await page.evaluate(()=>{Storage.prototype.setItem=()=>{throw Error('unavailable');};});
  await region(page).getByRole('button',{name:'Retire connection',exact:true}).click();await page.getByRole('dialog').getByRole('button',{name:'Retire connection',exact:true}).click();
  await expect(page.getByRole('dialog')).toContainText('No request was sent');expect(f.posts).toHaveLength(0);
});

test("admin connections retain stale rows and block changes after malformed refresh",async({page})=>{
  const f=fixture();await open(page,f);await expect(region(page)).toContainText('Design workstation');f.behavior.malformed='array-state';
  await region(page).getByRole('button',{name:'Refresh connections'}).click();await expect(region(page)).toContainText('could not be refreshed');await expect(region(page)).toContainText('Design workstation');
  await expect(region(page).getByRole('button',{name:'Retire connection',exact:true})).toBeDisabled();expect(f.posts).toHaveLength(0);
});

test("admin connections keep recovery available when legacy customer detail fails",async({page})=>{
  const f=fixture();f.behavior.detailFailure=true;await open(page,f);await expect(region(page)).toContainText('Design workstation');
  await region(page).getByRole('button',{name:'Retire connection',exact:true}).click();await expect(page.getByRole('dialog')).toContainText(f.row.binding_id);
  await expect(page.getByRole('dialog').getByRole('button',{name:'Cancel',exact:true})).toBeFocused();
});

test("admin connections invalidate parent actions when audit reveals another operator",async({page})=>{
  const f=fixture();await open(page,f);f.behavior.subject='different-operator';await region(page).getByText('History',{exact:true}).click();
  await expect(region(page)).toContainText('Refresh connections before making changes');await expect(region(page).getByRole('button',{name:'Retire connection',exact:true})).toBeDisabled();
});

test("admin connections never clear an unknown outcome from an undocumented error",async({page})=>{
  const f=fixture();f.behavior.postFailure='not_found';await open(page,f);await region(page).getByRole('button',{name:'Retire connection',exact:true}).click();
  await page.getByRole('dialog').getByRole('button',{name:'Retire connection',exact:true}).click();await expect(page.getByRole('dialog')).toContainText('result is not confirmed');
  await expect(page.getByRole('dialog').getByRole('button',{name:'Review current connection'})).toHaveCount(0);await expect(page.getByRole('dialog').getByRole('button',{name:'Retry same request'})).toBeEnabled();
});

test("admin connections discard a late exact review after its dialog is reopened",async({page})=>{
  const f=fixture();f.behavior.drop=true;await open(page,f);await region(page).getByRole('button',{name:'Retire connection',exact:true}).click();await page.getByRole('dialog').getByRole('button',{name:'Retire connection',exact:true}).click();
  await expect(page.getByRole('dialog')).toContainText('result is not confirmed');await page.getByRole('dialog').getByRole('button',{name:'Close',exact:true}).click();
  f.behavior.role='reader';await region(page).getByRole('button',{name:'Refresh connections'}).click();await region(page).getByRole('button',{name:'Review saved request'}).click();
  let release;f.behavior.reviewGate=new Promise(resolve=>{release=resolve;});await page.getByRole('dialog').getByRole('button',{name:'Review current connection'}).click();
  await expect(page.getByRole('dialog').getByRole('button',{name:'Review current connection'})).toBeDisabled();await page.getByRole('dialog').getByRole('button',{name:'Close',exact:true}).click();
  await region(page).getByRole('button',{name:'Review saved request'}).click();release();f.behavior.reviewGate=null;
  await expect(page.getByRole('dialog').getByRole('button',{name:'Review current connection'})).toBeEnabled();await expect(page.getByRole('dialog').getByRole('button',{name:'Clear reviewed request'})).toHaveCount(0);expect(f.posts).toHaveLength(1);
});

test("admin connections mobile dialog fits, traps focus and returns focus on cancel",async({page},testInfo)=>{
  const f=fixture();await page.setViewportSize({width:390,height:844});await open(page,f);
  await region(page).getByRole('button',{name:'Retire connection',exact:true}).click();const dialog=page.getByRole('dialog');await expect(dialog).toBeVisible();
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth)).toBe(true);
  for(let n=0;n<6;n++){await page.keyboard.press('Tab');expect(await dialog.evaluate(el=>el.contains(document.activeElement))).toBe(true);}
  await page.screenshot({path:testInfo.outputPath('connections-mobile.png')});await page.keyboard.press('Escape');await expect(dialog).not.toBeVisible();
  await expect(region(page).getByRole('heading',{name:'Protected connections',exact:true})).toBeFocused();expect(f.posts).toHaveLength(0);
});

test("admin connections reopen an unsent confirmation after section navigation",async({page})=>{
  const f=fixture();await open(page,f);
  const tabs=page.getByRole('navigation',{name:'Customer detail sections'});await tabs.getByRole('button',{name:'Activity',exact:true}).click();await tabs.getByRole('button',{name:'Apps & access',exact:true}).click();
  await region(page).getByRole('button',{name:'Retire connection',exact:true}).click();await page.goBack();
  await expect(page.getByRole('dialog')).not.toBeVisible();await page.goForward();
  await region(page).getByRole('button',{name:'Retire connection',exact:true}).click();await expect(page.getByRole('dialog')).toBeVisible();expect(f.posts).toHaveLength(0);
});

test("admin connections preserve known success after local cleanup and retry failures",async({page})=>{
  const f=fixture();await open(page,f);await page.evaluate(()=>{Storage.prototype.removeItem=()=>{throw Error('cleanup blocked');};});
  await region(page).getByRole('button',{name:'Retire connection',exact:true}).click();await page.getByRole('dialog').getByRole('button',{name:'Retire connection',exact:true}).click();
  await expect(page.getByRole('dialog')).toContainText('Retirement has been confirmed');f.behavior.drop=true;
  await page.getByRole('dialog').getByRole('button',{name:'Retry same request'}).click();await expect(page.getByRole('dialog')).toContainText('Retirement was already confirmed');expect(f.posts[1]).toEqual(f.posts[0]);
});

test("admin connections require a review before clearing unreadable saved state",async({page})=>{
  const f=fixture();await page.addInitScript(()=>sessionStorage.setItem('licensecc.admin-retirement.v1:cus_acme','not-json'));await open(page,f);
  await expect(region(page).getByRole('button',{name:'Retire connection',exact:true})).toBeDisabled();await region(page).getByRole('button',{name:'Review saved request'}).click();
  const dialog=page.getByRole('dialog');await expect(dialog.getByRole('button',{name:'Clear reviewed request'})).toHaveCount(0);
  await dialog.getByRole('button',{name:'Review current connection'}).click();await dialog.getByRole('button',{name:'Clear reviewed request'}).click();
  await expect(region(page).getByRole('button',{name:'Retire connection',exact:true})).toBeEnabled();expect(f.posts).toHaveLength(0);
});
