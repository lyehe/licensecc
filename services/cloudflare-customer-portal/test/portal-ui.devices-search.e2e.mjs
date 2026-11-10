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

function devicePage(url,items) {
  const project=url.searchParams.get('project'),cursor=url.searchParams.get('cursor')??'',query=(url.searchParams.get('q')??'').trim().toLowerCase();
  const candidates=items.filter(row=>(project===null || row.project===project) && row.binding_id>cursor).sort((a,b)=>a.binding_id<b.binding_id?-1:1);
  const scanned=candidates.slice(0,100),more=candidates.length>100;
  return {customer_id:'A',items:scanned.filter(row=>[row.label||'Unnamed device',row.binding_id,row.project].some(value=>value.toLowerCase().includes(query))),has_more:more,next_cursor:more?scanned.at(-1).binding_id:null};
}
async function setup(page,{items=[bindingWarehouse,bindingOffice,bindingLab],read}={}) {
  const reads=[];
  await page.route('**/api/portal/**', async route => {
    const url=new URL(route.request().url());
    if(url.pathname.endsWith('/me'))return route.fulfill({json:envelope('me',{customer_id:'A'})});
    if(url.pathname.endsWith('/device-bindings')){reads.push(url);return read?read(route,url):route.fulfill({json:envelope('device_bindings',devicePage(url,items))});}
    if(url.pathname.endsWith('/entitlements'))return route.fulfill({json:envelope('entitlements',{items:[entitlementDefault,entitlementSecond]})});
    return route.fulfill({json:envelope('ok',{items:[]})});
  });
  return reads;
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
test('devices: search finds a match beyond the first hundred candidates without loading unrelated rows',async({page})=>{
  const ids=Array.from({length:102},(_,i)=>{
    const buffer=Buffer.alloc(16);
    buffer.writeUInt32BE(i+1,12);
    return buffer.toString('base64url');
  }).sort();
  const items=ids.map((id,i)=>({...bindingWarehouse,binding_id:id,label:i===101?'Étage scanner':`Device ${i}`}));
  const reads=await setup(page,{items});
  await page.goto('/#/nodes');
  await expect(page.locator('.protectedNodes tbody tr')).toHaveCount(100);
  await page.getByRole('searchbox',{name:'Find a device'}).fill('éTAGE');
  await expect(page.locator('.protectedNodes tbody tr')).toHaveCount(1);
  await expect(page.locator('.protectedNodes tbody tr')).toContainText('Étage scanner');
  expect(reads.filter(url=>url.searchParams.has('q'))).toHaveLength(2);
  await expect(page.getByRole('button',{name:'Continue search'})).toHaveCount(0);
});

test('devices: search budget exhaustion is explicit and Continue search reaches the remaining candidates',async({page})=>{
  const ids=Array.from({length:601},(_,i)=>{const value=Buffer.alloc(16);value.writeUInt32BE(i+1,12);return value.toString('base64url');}).sort();
  const items=ids.map((id,i)=>({...bindingWarehouse,binding_id:id,label:i===600?'Last scanner':`Device ${i}`}));
  const reads=await setup(page,{items});
  await page.goto('/#/nodes');await page.getByRole('searchbox',{name:'Find a device'}).fill('Last scanner');
  await expect(page.getByRole('heading',{name:'Search incomplete'})).toBeVisible();
  expect(reads.filter(url=>url.searchParams.has('q'))).toHaveLength(5);
  await expect(page.getByRole('heading',{name:'No matching devices'})).toHaveCount(0);
  await page.getByRole('button',{name:'Continue search'}).click();
  await expect(page.locator('.protectedNodes tbody tr')).toContainText('Last scanner');
  expect(reads.filter(url=>url.searchParams.has('q'))).toHaveLength(7);
});

test('devices: query A to B to A fences a late response from the first A',async({page})=>{
  let release,started,officeReads=0;
  const first=new Promise(resolve=>{started=resolve;});
  await setup(page,{read:async(route,url)=>{
    if(url.searchParams.get('q')==='Office' && ++officeReads===1){started();await new Promise(resolve=>{release=resolve;});return route.fulfill({json:envelope('device_bindings',{customer_id:'A',items:[{...bindingOffice,label:'Stale Office'}],has_more:false,next_cursor:null})});}
    return route.fulfill({json:envelope('device_bindings',devicePage(url,[bindingWarehouse,bindingOffice]))});
  }});
  await page.goto('/#/nodes');const search=page.getByRole('searchbox',{name:'Find a device'});
  await search.fill('Office');await first;
  await search.fill('Warehouse');await expect(page.locator('.protectedNodes tbody tr')).toContainText('Warehouse Scanner');
  await search.fill('Office');await expect(page.locator('.protectedNodes tbody tr')).toContainText('Office Printer');
  const late=page.waitForResponse(response=>new URL(response.url()).searchParams.get('q')==='Office');
  release();await (await late).finished();
  await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
  await expect(page.getByText('Stale Office')).toHaveCount(0);
  await expect(page.locator('.protectedNodes tbody tr')).toContainText('Office Printer');
});

test('devices: a repeated search cursor stops traversal and never reports a final empty result',async({page})=>{
  const cursor=Buffer.alloc(16,9).toString('base64url');let searches=0;
  await setup(page,{read:(route,url)=>{
    if(url.searchParams.has('q')){searches++;return route.fulfill({json:envelope('device_bindings',{customer_id:'A',items:[],has_more:true,next_cursor:cursor})});}
    return route.fulfill({json:envelope('device_bindings',devicePage(url,[bindingWarehouse]))});
  }});
  await page.goto('/#/nodes');await page.getByRole('searchbox',{name:'Find a device'}).fill('Missing scanner');
  await expect(page.getByRole('alert')).toContainText('out of date');
  expect(searches).toBe(2);
  await expect(page.getByRole('heading',{name:'No matching devices'})).toHaveCount(0);
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
