import { expect } from '@playwright/test';
import { makeProtectedConnectionsFixture as fixture, test } from './admin-ui.fixture.mjs';

async function open(page,f){await page.route('**/api/admin/**',f.route);await page.goto('/');await expect(page.getByRole('button',{name:'Search',exact:true})).toBeVisible();if(await page.getByRole('button',{name:'Menu',exact:true}).isVisible())await page.getByRole('button',{name:'Menu',exact:true}).click();await page.getByRole('navigation',{name:'Main navigation'}).getByRole('link',{name:'Customers',exact:true}).click();await expect(page.getByRole('region',{name:'Customers',exact:true})).toContainText('Acme Corp');if(await page.locator('#customer-open-cus_acme').isVisible())await page.locator('#customer-open-cus_acme').click();else await page.getByRole('article').filter({has:page.getByRole('heading',{name:'Acme Corp',exact:true})}).getByRole('button',{name:'Open details'}).click();await expect(page.getByRole('heading',{name:'Protected connections',exact:true})).toBeVisible();}
const region=page=>page.getByRole('region',{name:'Protected connections'});

test("admin connections retire with explicit hold, exact request and audit history",async({page},testInfo)=>{
  const f=fixture();await open(page,f);
  await expect(region(page)).toContainText('Design workstation');await region(page).screenshot({path:testInfo.outputPath('connections-desktop.png')});
  const trigger=region(page).getByRole('button',{name:'Disconnect',exact:true});
  await expect(trigger).toHaveClass(/danger/);
  await trigger.click();
  const dialog=page.getByRole('dialog');await expect(dialog).toContainText('Existing signed offline access');await expect(dialog).toContainText('cus_acme');
  const commit=dialog.getByRole('button',{name:'Disconnect',exact:true});
  await expect(commit).toHaveClass(/danger/);
  await expect(commit).toBeDisabled();
  await dialog.getByLabel('Type DISCONNECT to confirm').fill('DISCONNECT');
  await expect(commit).toBeEnabled();
  await commit.evaluate(button=>{button.click();button.click();});
  await expect(dialog).not.toBeVisible();await expect(region(page)).toContainText('Renewal stopped for Design workstation');
  expect(f.posts).toHaveLength(1);expect(JSON.parse(f.posts[0].body)).toEqual({expected_revision:0});expect(f.posts[0].key).toMatch(/^[A-Za-z0-9_-]{43}$/);
  await expect(region(page).getByRole('heading',{name:'Protected connections',exact:true})).toBeFocused();
  await region(page).getByText('History',{exact:true}).click();await expect(region(page)).toContainText('operator:access:operator-one');
});

test("admin connections reach and operate the typed Disconnect field using only the keyboard",async({page})=>{
  const f=fixture();await open(page,f);
  await region(page).getByRole('button',{name:'Disconnect',exact:true}).click();
  const dialog=page.getByRole('dialog');await expect(dialog).toBeVisible();
  const input=dialog.getByLabel('Type DISCONNECT to confirm');
  const cancelButton=dialog.getByRole('button',{name:'Cancel',exact:true});
  const commitButton=dialog.getByRole('button',{name:'Disconnect',exact:true});
  // Start from Cancel (a `.focus()` call, not a `.fill()`) and reach the field going backwards --
  // the exact direction the reported trap could never leave (Shift+Tab stayed on Cancel forever).
  await cancelButton.focus();
  await expect(cancelButton).toBeFocused();
  await page.keyboard.press('Shift+Tab');
  await expect(input).toBeFocused();
  await expect(commitButton).toBeDisabled();
  await page.keyboard.type('DISCONNECT');
  await expect(commitButton).toBeEnabled();
  await page.keyboard.press('Tab');
  await expect(commitButton).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(dialog).not.toBeVisible();
  expect(f.posts).toHaveLength(1);
  expect(JSON.parse(f.posts[0].body)).toEqual({expected_revision:0});
});

test("admin connections clear the typed Disconnect field synchronously on open, including a resumed request",async({page})=>{
  const f=fixture();f.behavior.drop=true;await open(page,f);
  await region(page).getByRole('button',{name:'Disconnect',exact:true}).click();
  let dialog=page.getByRole('dialog');
  await dialog.getByLabel('Type DISCONNECT to confirm').fill('DISCONNECT');
  await expect(dialog.getByRole('button',{name:'Disconnect',exact:true})).toBeEnabled();
  await dialog.getByRole('button',{name:'Cancel',exact:true}).click();
  await expect(dialog).not.toBeVisible();

  // Reopening the same pending request must never show the previous "DISCONNECT" value or an
  // enabled commit button, not even for one render. Read the field back with plain one-shot
  // locator reads (never a retrying `expect(locator)`, which could let a later correction settle
  // in before this looks) as soon as the dialog reports itself visible.
  await region(page).getByRole('button',{name:'Disconnect',exact:true}).click();
  dialog=page.getByRole('dialog');await expect(dialog).toBeVisible();
  const reopenedInput=dialog.getByLabel('Type DISCONNECT to confirm');
  const reopenedCommit=dialog.getByRole('button',{name:'Disconnect',exact:true});
  const [reopenedValue,reopenedDisabled]=await Promise.all([reopenedInput.inputValue(),reopenedCommit.isDisabled()]);
  expect({value:reopenedValue,disabled:reopenedDisabled}).toEqual({value:'',disabled:true});

  // Cover resume(): send (the fixture drops the response), close, then resume the saved request.
  await dialog.getByLabel('Type DISCONNECT to confirm').fill('DISCONNECT');
  await dialog.getByRole('button',{name:'Disconnect',exact:true}).click();
  await expect(dialog).toContainText('result is not confirmed');
  await dialog.getByRole('button',{name:'Close',exact:true}).click();
  await expect(dialog).not.toBeVisible();
  await region(page).getByRole('button',{name:'Review saved request'}).click();
  dialog=page.getByRole('dialog');await expect(dialog).toBeVisible();
  const resumedInput=dialog.getByLabel('Type DISCONNECT to confirm');
  const resumedCommit=dialog.getByRole('button',{name:'Retry same request',exact:true});
  const [resumedValue,resumedDisabled]=await Promise.all([resumedInput.inputValue(),resumedCommit.isDisabled()]);
  expect({value:resumedValue,disabled:resumedDisabled}).toEqual({value:'',disabled:true});
});

test("admin connections recover a lost response after reload using the original operator and key",async({page})=>{
  const f=fixture();f.behavior.drop=true;await open(page,f);
  await region(page).getByRole('button',{name:'Disconnect',exact:true}).click();
  await page.getByRole('dialog').getByLabel('Type DISCONNECT to confirm').fill('DISCONNECT');
  await page.getByRole('dialog').getByRole('button',{name:'Disconnect',exact:true}).click();
  await expect(page.getByRole('dialog')).toContainText('result is not confirmed');await expect(page.getByRole('dialog').getByRole('button',{name:'Review current connection'})).toHaveCount(0);await page.reload();
  await page.getByRole('navigation',{name:'Main navigation'}).getByRole('link',{name:'Customers',exact:true}).click();await page.locator('#customer-open-cus_acme').click();
  await region(page).getByRole('button',{name:'Review saved request'}).click();
  await page.getByRole('dialog').getByLabel('Type DISCONNECT to confirm').fill('DISCONNECT');
  await page.getByRole('dialog').getByRole('button',{name:'Retry same request'}).click();
  await expect(page.getByRole('dialog')).not.toBeVisible();expect(f.posts).toHaveLength(2);expect(f.posts[1]).toEqual(f.posts[0]);
});

test("admin connections let a changed reader review and clear without another retirement",async({page})=>{
  const f=fixture();f.behavior.drop=true;await open(page,f);
  await region(page).getByRole('button',{name:'Disconnect',exact:true}).click();
  await page.getByRole('dialog').getByLabel('Type DISCONNECT to confirm').fill('DISCONNECT');
  await page.getByRole('dialog').getByRole('button',{name:'Disconnect',exact:true}).click();
  await expect(page.getByRole('dialog')).toContainText('result is not confirmed');await page.getByRole('dialog').getByRole('button',{name:'Close',exact:true}).click();
  f.behavior.role='reader';f.behavior.subject='reader-two';await region(page).getByRole('button',{name:'Refresh connections'}).click();
  await region(page).getByRole('button',{name:'Review saved request'}).click();const dialog=page.getByRole('dialog');await expect(dialog.getByRole('button',{name:'Retry same request'})).toBeDisabled();
  await dialog.getByRole('button',{name:'Review current connection'}).click();await expect(dialog).toContainText('Current connection: Disconnecting');
  await dialog.getByRole('button',{name:'Clear reviewed request'}).click();expect(f.posts).toHaveLength(1);await expect(region(page).getByRole('button',{name:'Disconnect',exact:true})).toHaveCount(0);
});

test("admin connections block a write when durable tab storage is unavailable",async({page})=>{
  const f=fixture();await open(page,f);await page.evaluate(()=>{Storage.prototype.setItem=()=>{throw Error('unavailable');};});
  await region(page).getByRole('button',{name:'Disconnect',exact:true}).click();
  await page.getByRole('dialog').getByLabel('Type DISCONNECT to confirm').fill('DISCONNECT');
  await page.getByRole('dialog').getByRole('button',{name:'Disconnect',exact:true}).click();
  await expect(page.getByRole('dialog')).toContainText('No request was sent');expect(f.posts).toHaveLength(0);
});

test("admin connections retain stale rows and block changes after malformed refresh",async({page})=>{
  const f=fixture();await open(page,f);await expect(region(page)).toContainText('Design workstation');f.behavior.malformed='array-state';
  await region(page).getByRole('button',{name:'Refresh connections'}).click();await expect(region(page)).toContainText('could not be refreshed');await expect(region(page)).toContainText('Design workstation');
  await expect(region(page).getByRole('button',{name:'Disconnect',exact:true})).toBeDisabled();expect(f.posts).toHaveLength(0);
});

test("admin connections keep recovery available when legacy customer detail fails",async({page})=>{
  const f=fixture();f.behavior.detailFailure=true;await open(page,f);await expect(region(page)).toContainText('Design workstation');
  await region(page).getByRole('button',{name:'Disconnect',exact:true}).click();await expect(page.getByRole('dialog')).toContainText(f.row.binding_id);
  // Initial focus goes to the typed field, matching the shared confirm dialog's own initial focus.
  await expect(page.getByRole('dialog').getByLabel('Type DISCONNECT to confirm')).toBeFocused();
});

test("admin connections invalidate parent actions when audit reveals another operator",async({page})=>{
  const f=fixture();await open(page,f);f.behavior.subject='different-operator';await region(page).getByText('History',{exact:true}).click();
  await expect(region(page)).toContainText('Refresh connections before making changes');await expect(region(page).getByRole('button',{name:'Disconnect',exact:true})).toBeDisabled();
});

test("admin connections never clear an unknown outcome from an undocumented error",async({page})=>{
  const f=fixture();f.behavior.postFailure='not_found';await open(page,f);await region(page).getByRole('button',{name:'Disconnect',exact:true}).click();
  await page.getByRole('dialog').getByLabel('Type DISCONNECT to confirm').fill('DISCONNECT');
  await page.getByRole('dialog').getByRole('button',{name:'Disconnect',exact:true}).click();await expect(page.getByRole('dialog')).toContainText('result is not confirmed');
  await expect(page.getByRole('dialog').getByRole('button',{name:'Review current connection'})).toHaveCount(0);await expect(page.getByRole('dialog').getByRole('button',{name:'Retry same request'})).toBeEnabled();
});

test("admin connections discard a late exact review after its dialog is reopened",async({page})=>{
  const f=fixture();f.behavior.drop=true;await open(page,f);await region(page).getByRole('button',{name:'Disconnect',exact:true}).click();
  await page.getByRole('dialog').getByLabel('Type DISCONNECT to confirm').fill('DISCONNECT');
  await page.getByRole('dialog').getByRole('button',{name:'Disconnect',exact:true}).click();
  await expect(page.getByRole('dialog')).toContainText('result is not confirmed');await page.getByRole('dialog').getByRole('button',{name:'Close',exact:true}).click();
  f.behavior.role='reader';await region(page).getByRole('button',{name:'Refresh connections'}).click();await region(page).getByRole('button',{name:'Review saved request'}).click();
  let release;f.behavior.reviewGate=new Promise(resolve=>{release=resolve;});await page.getByRole('dialog').getByRole('button',{name:'Review current connection'}).click();
  await expect(page.getByRole('dialog').getByRole('button',{name:'Review current connection'})).toBeDisabled();await page.getByRole('dialog').getByRole('button',{name:'Close',exact:true}).click();
  await region(page).getByRole('button',{name:'Review saved request'}).click();release();f.behavior.reviewGate=null;
  await expect(page.getByRole('dialog').getByRole('button',{name:'Review current connection'})).toBeEnabled();await expect(page.getByRole('dialog').getByRole('button',{name:'Clear reviewed request'})).toHaveCount(0);expect(f.posts).toHaveLength(1);
});

test("admin connections mobile dialog fits, traps focus and returns focus on cancel",async({page},testInfo)=>{
  const f=fixture();await page.setViewportSize({width:390,height:844});await open(page,f);
  await region(page).getByRole('button',{name:'Disconnect',exact:true}).click();const dialog=page.getByRole('dialog');await expect(dialog).toBeVisible();
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth)).toBe(true);
  for(let n=0;n<6;n++){await page.keyboard.press('Tab');expect(await dialog.evaluate(el=>el.contains(document.activeElement))).toBe(true);}
  await page.screenshot({path:testInfo.outputPath('connections-mobile.png')});await page.keyboard.press('Escape');await expect(dialog).not.toBeVisible();
  await expect(region(page).getByRole('heading',{name:'Protected connections',exact:true})).toBeFocused();expect(f.posts).toHaveLength(0);
});

test("admin connections reopen an unsent confirmation after section navigation",async({page})=>{
  const f=fixture();await open(page,f);
  const tabs=page.getByRole('navigation',{name:'Customer detail sections'});await tabs.getByRole('button',{name:'Activity',exact:true}).click();await tabs.getByRole('button',{name:'Apps & access',exact:true}).click();
  await region(page).getByRole('button',{name:'Disconnect',exact:true}).click();await page.goBack();
  await expect(page.getByRole('dialog')).not.toBeVisible();await page.goForward();
  await region(page).getByRole('button',{name:'Disconnect',exact:true}).click();await expect(page.getByRole('dialog')).toBeVisible();expect(f.posts).toHaveLength(0);
});

test("admin connections preserve known success after local cleanup and retry failures",async({page})=>{
  const f=fixture();await open(page,f);await page.evaluate(()=>{Storage.prototype.removeItem=()=>{throw Error('cleanup blocked');};});
  await region(page).getByRole('button',{name:'Disconnect',exact:true}).click();
  await page.getByRole('dialog').getByLabel('Type DISCONNECT to confirm').fill('DISCONNECT');
  await page.getByRole('dialog').getByRole('button',{name:'Disconnect',exact:true}).click();
  await expect(page.getByRole('dialog')).toContainText('Disconnection has been confirmed');f.behavior.drop=true;
  await page.getByRole('dialog').getByRole('button',{name:'Retry same request'}).click();await expect(page.getByRole('dialog')).toContainText('Disconnection was already confirmed');expect(f.posts[1]).toEqual(f.posts[0]);
});

test("admin connections require a review before clearing unreadable saved state",async({page})=>{
  const f=fixture();await page.addInitScript(()=>sessionStorage.setItem('licensecc.admin-retirement.v1:cus_acme','not-json'));await open(page,f);
  await expect(region(page).getByRole('button',{name:'Disconnect',exact:true})).toBeDisabled();await region(page).getByRole('button',{name:'Review saved request'}).click();
  const dialog=page.getByRole('dialog');await expect(dialog.getByRole('button',{name:'Clear reviewed request'})).toHaveCount(0);
  await dialog.getByRole('button',{name:'Review current connection'}).click();await dialog.getByRole('button',{name:'Clear reviewed request'}).click();
  await expect(region(page).getByRole('button',{name:'Disconnect',exact:true})).toBeEnabled();expect(f.posts).toHaveLength(0);
});

test("admin connections show device-limit capacity and recent refused connections",async({page})=>{
  const f=fixture();await open(page,f);
  await expect(region(page)).toContainText('Device limit');await expect(region(page)).toContainText('1 of 2 in use');
  await expect(region(page)).toContainText('Recent refused connections');await expect(region(page)).toContainText('sha256:dddddddd');
  await expect(region(page).locator('.connectionCapacity')).toContainText('aaaaaaaa...aaaaaaaa');
  await expect(region(page).locator('.recentRefusals')).toContainText('aaaaaaaa...aaaaaaaa');
});

test("admin connections report no refused connections when this list's licenses have none",async({page})=>{
  const f=fixture();f.behavior.denied=[];await open(page,f);
  await expect(region(page)).toContainText("No refused connections in this list's licenses.");
});
