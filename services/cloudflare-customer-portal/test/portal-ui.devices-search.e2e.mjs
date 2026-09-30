import {expect,test} from '@playwright/test';

// One devices page in customer terms -- a single search box above Connected devices, plus an
// exact app filter carried by the route (`#/nodes/{project}`) and shown as a removable
// "App: {project}" chip.
const now=1800000000;
let requestCounter=0;
function envelope(code,data){requestCounter+=1;return {ok:true,code,request_id:`devices-search-${requestCounter}`,data};}

const bindingWarehouse={binding_id:Buffer.alloc(16,1).toString('base64url'),project:'DEFAULT',feature:'pro',revision:0,hold_until:now+3600,state:'active',label:'Warehouse Scanner',last_proof_at:now-30,created_at:now-3600,server_time:now};
const bindingOffice={binding_id:Buffer.alloc(16,2).toString('base64url'),project:'DEFAULT',feature:'pro',revision:0,hold_until:now+3600,state:'active',label:'Office Printer',last_proof_at:now-30,created_at:now-3600,server_time:now};
const bindingLab={binding_id:Buffer.alloc(16,3).toString('base64url'),project:'SECOND_APP',feature:'pro',revision:0,hold_until:now+3600,state:'active',label:'Lab Tablet',last_proof_at:now-30,created_at:now-3600,server_time:now};

const entitlementDefault={id:'ent_default',project:'DEFAULT',feature:'pro',status:'active',license_fingerprint:'a'.repeat(64),valid_from:now-10000,valid_until:null,license_mode:'node_locked',max_active_devices:1,policy_id:'pol_default',trial_ends_at:null,trial_starts_on_activation:false};
const entitlementSecond={...entitlementDefault,id:'ent_second',project:'SECOND_APP',license_fingerprint:'b'.repeat(64),policy_id:'pol_second'};

async function setup(page) {
  await page.route('**/api/portal/**', async route => {
    const url=new URL(route.request().url());
    if(url.pathname.endsWith('/me'))return route.fulfill({json:envelope('me',{customer_id:'A'})});
    if(url.pathname.endsWith('/device-bindings'))return route.fulfill({json:envelope('device_bindings',{customer_id:'A',items:[bindingWarehouse,bindingOffice,bindingLab],has_more:false,next_cursor:null})});
    if(url.pathname.endsWith('/entitlements'))return route.fulfill({json:envelope('entitlements',{items:[entitlementDefault,entitlementSecond]})});
    return route.fulfill({json:envelope('ok',{items:[]})});
  });
}

test('devices: searching a connected device label shows it and hides a non-matching one',async({page})=>{
  await setup(page);
  await page.goto('/#/nodes');
  await expect(page.locator('.protectedNodes tr').filter({hasText:'Warehouse Scanner'})).toHaveCount(1);
  await expect(page.locator('.protectedNodes tr').filter({hasText:'Office Printer'})).toHaveCount(1);
  await page.getByRole('searchbox',{name:'Find a device'}).fill('Warehouse');
  await expect(page.locator('.protectedNodes tr').filter({hasText:'Warehouse Scanner'})).toHaveCount(1);
  await expect(page.locator('.protectedNodes tr').filter({hasText:'Office Printer'})).toHaveCount(0);
});

// A search/app filter that empties the LOADED page must still say
// more devices may be waiting on later pages, rather than implying "No matching devices" is final.
test('devices: a search that empties the loaded page still hints that more devices may exist',async({page})=>{
  const ids=Array.from({length:100},(_,i)=>{
    const buffer=Buffer.alloc(16);
    buffer.writeUInt32BE(i+1,12);
    return buffer.toString('base64url');
  }).sort();
  const items=ids.map((id,i)=>({binding_id:id,project:'DEFAULT',feature:'pro',revision:0,hold_until:now+3600,state:'active',label:`Device ${i}`,last_proof_at:now-30,created_at:now-3600,server_time:now}));
  await page.route('**/api/portal/**', async route => {
    const url=new URL(route.request().url());
    if(url.pathname.endsWith('/me'))return route.fulfill({json:envelope('me',{customer_id:'A'})});
    if(url.pathname.endsWith('/device-bindings'))return route.fulfill({json:envelope('device_bindings',{customer_id:'A',items,has_more:true,next_cursor:ids[ids.length-1]})});
    if(url.pathname.endsWith('/entitlements'))return route.fulfill({json:envelope('entitlements',{items:[]})});
    return route.fulfill({json:envelope('ok',{items:[]})});
  });
  await page.goto('/#/nodes');
  await expect(page.locator('.protectedNodes tbody tr')).toHaveCount(100);
  await page.getByRole('searchbox',{name:'Find a device'}).fill('no-such-device-anywhere');
  await expect(page.getByRole('heading',{name:'No matching devices'})).toBeVisible();
  await expect(page.getByText('Showing matches from loaded devices.')).toBeVisible();
});

test('devices: "View devices" from an app filters to that app, and Show all apps clears it',async({page})=>{
  await setup(page);
  await page.goto('/#/apps');
  await page.getByRole('link',{name:'View licenses for DEFAULT'}).click();
  await page.getByRole('link',{name:'View devices'}).click();
  await expect(page).toHaveURL(/#\/nodes\/DEFAULT$/);
  await expect(page.getByText('App: DEFAULT')).toBeVisible();
  await expect(page.locator('.protectedNodes tr').filter({hasText:'Warehouse Scanner'})).toHaveCount(1);
  await expect(page.locator('.protectedNodes tr').filter({hasText:'Lab Tablet'})).toHaveCount(0);
  await page.getByRole('link',{name:'Show all apps'}).click();
  await expect(page).toHaveURL(/#\/nodes$/);
  await expect(page.locator('.protectedNodes tr').filter({hasText:'Lab Tablet'})).toHaveCount(1);
});

test('devices: an app that is not in the account says so and links back to all apps',async({page})=>{
  await setup(page);
  await page.goto('/#/nodes/NO_SUCH_APP');
  const notice=page.getByRole('status').filter({hasText:'No app named "NO_SUCH_APP" is in your account.'});
  await expect(notice).toBeVisible();
  await expect(notice.getByRole('link',{name:'Show all apps'})).toHaveAttribute('href','#/nodes');
  await expect(page.getByText('App: NO_SUCH_APP')).toHaveCount(0);
  await notice.getByRole('link',{name:'Show all apps'}).click();
  await expect(page).toHaveURL(/#\/nodes$/);
  await expect(page.locator('.protectedNodes tr').filter({hasText:'Warehouse Scanner'})).toHaveCount(1);
  await expect(page.getByText('No app named',{exact:false})).toHaveCount(0);
});

// The unknown-app message reads the entitlements list; while that read is still loading (or has
// failed), entitlements is [] -- indistinguishable from a real empty account -- so the page must
// never claim a valid app is unknown just because the read has not resolved yet.
test('devices: a delayed entitlements read never claims a valid app is unknown while loading',async({page})=>{
  let releaseEntitlements;
  const gate=new Promise(resolve=>{releaseEntitlements=resolve;});
  await page.route('**/api/portal/**', async route => {
    const url=new URL(route.request().url());
    if(url.pathname.endsWith('/me'))return route.fulfill({json:envelope('me',{customer_id:'A'})});
    if(url.pathname.endsWith('/device-bindings'))return route.fulfill({json:envelope('device_bindings',{customer_id:'A',items:[bindingWarehouse],has_more:false,next_cursor:null})});
    if(url.pathname.endsWith('/entitlements')){await gate;return route.fulfill({json:envelope('entitlements',{items:[entitlementDefault]})});}
    return route.fulfill({json:envelope('ok',{items:[]})});
  });
  await page.goto('/#/nodes/DEFAULT');
  // Connected devices already render (they do not wait on entitlements); the unknown-app message
  // must not appear while the entitlements read for a REAL app is still in flight.
  await expect(page.locator('.protectedNodes tr').filter({hasText:'Warehouse Scanner'})).toHaveCount(1);
  await expect(page.getByText('No app named',{exact:false})).toHaveCount(0);
  releaseEntitlements();
  await expect(page.getByText('App: DEFAULT',{exact:false})).toBeVisible();
  await expect(page.getByText('No app named',{exact:false})).toHaveCount(0);
});

// A permanently failed entitlements read must show the failure, not misreport a real app as unknown.
test('devices: a failed entitlements read shows the failure without claiming the app is unknown',async({page})=>{
  await page.route('**/api/portal/**', async route => {
    const url=new URL(route.request().url());
    if(url.pathname.endsWith('/me'))return route.fulfill({json:envelope('me',{customer_id:'A'})});
    if(url.pathname.endsWith('/device-bindings'))return route.fulfill({json:envelope('device_bindings',{customer_id:'A',items:[bindingWarehouse],has_more:false,next_cursor:null})});
    if(url.pathname.endsWith('/entitlements'))return route.fulfill({status:503,json:{ok:false,code:'temporarily_unavailable',request_id:'devices-search-fail'}});
    return route.fulfill({json:envelope('ok',{items:[]})});
  });
  await page.goto('/#/nodes/DEFAULT');
  await expect(page.getByRole('status').filter({hasText:'This is temporarily unavailable. Try again shortly.'})).toBeVisible();
  await expect(page.getByText('No app named',{exact:false})).toHaveCount(0);
  await expect(page.locator('.protectedNodes tr').filter({hasText:'Warehouse Scanner'})).toHaveCount(1);
});
