import {expect,test} from '@playwright/test';
const now=1800000000,id=Buffer.alloc(16,1).toString('base64url');
const row={binding_id:id,project:'Example app',feature:'DEFAULT',revision:0,hold_until:now+3600,state:'active',label:'Work laptop',last_proof_at:now-30,created_at:now-3600,server_time:now};
const envelope=(code,data)=>({ok:true,code,request_id:'nodes-test',data});
async function setup(page,options={}) {
  let rows=[{...row}],reads=0;const calls=[];
  await page.route('**/api/portal/**',async route=>{
    const request=route.request(),url=new URL(request.url());
    if(url.pathname.endsWith('/me'))return route.fulfill({json:envelope('me',{customer_id:'A'})});
    if(url.pathname.endsWith('/device-bindings/retire')) {
      calls.push({body:request.postDataJSON(),key:request.headers()['idempotency-key'],customer:request.headers()['x-expected-customer-id']});
      if(options.retire)return options.retire(route,calls);
      rows=[{...row,state:'retiring',revision:1}];
      return route.fulfill({json:envelope('binding_retired',{binding_id:id,state:'retiring',effective_release_at:row.hold_until,revision:1,generation:2})});
    }
    if(url.pathname.endsWith('/device-bindings')) {
      reads++;if(options.read)return options.read(route,reads);
      return route.fulfill({json:envelope('device_bindings',{customer_id:'A',items:rows,has_more:false,next_cursor:null})});
    }
    return route.fulfill({json:envelope('ok',{items:[]})});
  });
  return calls;
}

test('nodes: retirement confirmation preserves hold, refreshes status and explains transfer',async({page},testInfo)=>{
  const calls=await setup(page);await page.goto('/#/nodes');
  await expect(page.getByRole('heading',{name:'Connected devices'})).toBeVisible();
  await expect(page.getByRole('cell',{name:'Connected',exact:true})).toBeVisible();
  await page.getByRole('button',{name:'Disconnect',exact:true}).click();
  const dialog=page.getByRole('dialog');await expect(dialog).toBeVisible();
  await expect(dialog).toContainText('It may keep working until its current license expires');
  await expect(dialog).toContainText('This connection cannot be restored');
  await expect(dialog).toContainText('Example app · DEFAULT');await expect(dialog).toContainText(id);
  await dialog.getByRole('button',{name:'Cancel',exact:true}).click();expect(calls).toHaveLength(0);
  await page.getByRole('button',{name:'Disconnect',exact:true}).click();
  await dialog.getByRole('button',{name:'Disconnect device',exact:true}).click();
  await expect(dialog).not.toBeVisible();await expect(page.getByText(/Renewal stopped for Work laptop/)).toBeVisible();
  await expect(page.getByRole('heading',{name:'Connected devices'})).toBeFocused();
  await expect(page.getByRole('cell',{name:/Disconnecting/})).toBeVisible();
  expect(calls).toHaveLength(1);expect(calls[0].customer).toBe('A');expect(calls[0].body).toEqual({binding_id:id,expected_revision:0});expect(calls[0].key).toMatch(/^[A-Za-z0-9_-]{43}$/);
  expect(await page.evaluate(()=>sessionStorage.getItem('licensecc.retirement.v1:A'))).toBeNull();
  await page.screenshot({path:testInfo.outputPath('nodes-desktop.png'),fullPage:true});
});

test('nodes: unknown outcome and reload retry the exact saved body and key',async({page})=>{
  const calls=await setup(page,{retire:(route,attempts)=>attempts.length===1?route.abort():route.fulfill({json:envelope('binding_retired',{binding_id:id,state:'retiring',effective_release_at:row.hold_until,revision:1,generation:2})})});
  await page.goto('/#/nodes');await page.getByRole('button',{name:'Disconnect',exact:true}).click();await page.getByRole('button',{name:'Disconnect device',exact:true}).click();
  await expect(page.getByRole('alert')).toContainText('result is not confirmed');
  await page.reload();await page.getByRole('button',{name:'Review disconnect request',exact:true}).click();
  await page.getByRole('button',{name:'Retry disconnect',exact:true}).click();
  await expect(page.getByRole('dialog')).not.toBeVisible();expect(calls).toHaveLength(2);expect(calls[1]).toEqual(calls[0]);
});

test('nodes: storage failure prevents a retirement request',async({page})=>{
  const calls=await setup(page);await page.goto('/#/nodes');await page.getByRole('button',{name:'Disconnect',exact:true}).click();
  await page.evaluate(()=>{Storage.prototype.setItem=function(){throw new Error('blocked');};});
  await page.getByRole('button',{name:'Disconnect device',exact:true}).click();await expect(page.getByRole('alert')).toContainText('No request was sent');expect(calls).toHaveLength(0);
});

test('nodes: stale revision requires explicit review and refresh before a new intent',async({page})=>{
  const calls=await setup(page,{retire:route=>route.fulfill({status:409,json:{ok:false,code:'revision_conflict',request_id:'conflict'}})});
  await page.goto('/#/nodes');await page.getByRole('button',{name:'Disconnect',exact:true}).click();await page.getByRole('button',{name:'Disconnect device',exact:true}).click();
  await expect(page.getByRole('alert')).toContainText('Review current devices');
  await expect(page.getByRole('button',{name:'Retry disconnect',exact:true})).toHaveCount(0);
  await page.getByRole('button',{name:'Review current devices',exact:true}).click();await expect(page.getByRole('dialog')).toContainText('Current connection: Connected');
  await page.getByRole('button',{name:'Clear saved request',exact:true}).click();await expect(page.getByRole('dialog')).not.toBeVisible();expect(calls).toHaveLength(1);
  await expect(page.getByRole('heading',{name:'Connected devices'})).toBeFocused();
});

test('nodes: failed refresh preserves rows and disables retirement',async({page})=>{
  await setup(page,{read:(route,reads)=>reads>1?route.fulfill({status:503,json:{ok:false,code:'temporarily_unavailable'}}):route.fulfill({json:envelope('device_bindings',{customer_id:'A',items:[row],has_more:false,next_cursor:null})})});
  await page.goto('/#/nodes');await expect(page.getByRole('button',{name:'Disconnect',exact:true})).toBeEnabled();await page.getByRole('button',{name:'Refresh devices',exact:true}).click();
  await expect(page.getByRole('alert')).toContainText('out of date');await expect(page.getByRole('cell',{name:/Work laptop/})).toBeVisible();await expect(page.getByRole('button',{name:'Disconnect',exact:true})).toBeDisabled();
});

test('nodes: mobile layout, dialog focus and escape remain usable',async({page},testInfo)=>{
  await page.setViewportSize({width:390,height:844});await setup(page);await page.goto('/#/nodes');
  await page.getByRole('button',{name:'Disconnect',exact:true}).click();await expect(page.getByRole('dialog')).toBeVisible();
  expect(await page.evaluate(()=>document.querySelector('dialog').contains(document.activeElement))).toBe(true);
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
  await page.screenshot({path:testInfo.outputPath('nodes-mobile.png'),fullPage:true});
  await page.keyboard.press('Escape');await expect(page.getByRole('dialog')).not.toBeVisible();await expect(page.getByRole('heading',{name:'Connected devices'})).toBeFocused();
  for(const field of ['Device','App'])expect(await page.locator(`.protectedNodes td[data-label="${field}"]`).evaluate(cell=>cell.querySelector('span').getBoundingClientRect().left-cell.getBoundingClientRect().left)).toBeGreaterThan(80);
  await page.screenshot({path:testInfo.outputPath('nodes-mobile-list.png'),fullPage:true});
});

test('nodes: protected recovery remains available when legacy account data fails',async({page})=>{
  await setup(page);
  await page.route('**/api/portal/entitlements',route=>route.fulfill({status:503,json:{ok:false,code:'temporarily_unavailable'}}));
  await page.goto('/#/nodes');await expect(page.getByText('Registered machines unavailable')).toBeVisible();
  await expect(page.getByRole('button',{name:'Disconnect',exact:true})).toBeEnabled();
  await page.getByRole('button',{name:'Disconnect',exact:true}).click();await expect(page.getByRole('dialog')).toBeVisible();
});

test('nodes: account change on a read offers sign-in recovery',async({page})=>{
  await setup(page,{read:route=>route.fulfill({status:409,json:{ok:false,code:'account_changed'}})});
  await page.goto('/#/nodes');await expect(page.getByRole('button',{name:'Check sign-in',exact:true})).toBeVisible();
  await expect(page.getByText(/Your signed-in account changed/)).toBeVisible();
});

test('nodes: reviewing a saved target beyond page one inspects that exact binding before clearing',async({page})=>{
  const target=Buffer.alloc(16,255).toString('base64url'),key=Buffer.alloc(32,7).toString('base64url');
  const firstPage=Array.from({length:100},(_,index)=>({...row,binding_id:Buffer.alloc(16,index).toString('base64url')})).sort((a,b)=>a.binding_id<b.binding_id?-1:1);
  let inspected=false;
  await page.addInitScript(value=>sessionStorage.setItem('licensecc.retirement.v1:A',JSON.stringify(value)),{customer:'A',binding:target,revision:0,key,label:'Remote machine',project:row.project,feature:row.feature,hold:row.hold_until});
  await setup(page,{retire:route=>route.fulfill({status:409,json:{ok:false,code:'revision_conflict'}}),read:route=>{
    const query=new URL(route.request().url()).searchParams;
    if(query.get('binding_id')===target){inspected=true;return route.fulfill({json:envelope('device_bindings',{customer_id:'A',items:[{...row,binding_id:target,state:'released',revision:2}],has_more:false,next_cursor:null})});}
    return route.fulfill({json:envelope('device_bindings',{customer_id:'A',items:firstPage,has_more:true,next_cursor:firstPage.at(-1).binding_id})});
  }});
  await page.goto('/#/nodes');await page.getByRole('button',{name:'Review disconnect request',exact:true}).click();await page.getByRole('button',{name:'Retry disconnect',exact:true}).click();
  await page.getByRole('button',{name:'Review current devices',exact:true}).click();await expect(page.getByRole('dialog')).toContainText('Current connection: Disconnected');
  expect(inspected).toBe(true);expect(await page.evaluate(()=>sessionStorage.getItem('licensecc.retirement.v1:A'))).not.toBeNull();
  await page.getByRole('button',{name:'Clear saved request',exact:true}).click();expect(await page.evaluate(()=>sessionStorage.getItem('licensecc.retirement.v1:A'))).toBeNull();
});

test('nodes: load more appends a page and refresh resets pagination',async({page})=>{
  const all=Array.from({length:101},(_,i)=>({...row,binding_id:Buffer.alloc(16,i).toString('base64url')})).sort((a,b)=>a.binding_id<b.binding_id?-1:1);
  await setup(page,{read:route=>{
    const next=new URL(route.request().url()).searchParams.has('cursor');
    return route.fulfill({json:envelope('device_bindings',{customer_id:'A',items:next?all.slice(100):all.slice(0,100),has_more:!next,next_cursor:next?null:all[99].binding_id})});
  }});
  await page.goto('/#/nodes');await expect(page.getByRole('row')).toHaveCount(101);
  await page.getByRole('button',{name:'Load more devices'}).click();await expect(page.getByRole('row')).toHaveCount(102);
  await expect(page.getByRole('button',{name:'Load more devices'})).toHaveCount(0);
  await page.getByRole('button',{name:'Refresh devices'}).click();await expect(page.getByRole('row')).toHaveCount(101);
});

for(const kind of ['wrong account','duplicate rows','out of order'])test(`nodes: ${kind} response preserves the previous view and blocks retirement`,async({page})=>{
  const second={...row,binding_id:Buffer.alloc(16,2).toString('base64url')};
  await setup(page,{read:(route,count)=>route.fulfill({json:envelope('device_bindings',{customer_id:count>1 && kind==='wrong account'?'B':'A',
    items:count===1?[row]:kind==='duplicate rows'?[row,row]:kind==='out of order'?[second,row]:[row],has_more:false,next_cursor:null})})});
  await page.goto('/#/nodes');await expect(page.getByRole('button',{name:'Disconnect',exact:true})).toBeEnabled();await page.getByRole('button',{name:'Refresh devices'}).click();
  await expect(page.getByRole('alert')).toContainText('out of date');await expect(page.getByRole('row')).toHaveCount(2);await expect(page.getByRole('button',{name:'Disconnect',exact:true})).toBeDisabled();
});

test('nodes: exact review is single flight and a late response after navigation preserves pending intent',async({page})=>{
  let held,reads=0;
  await setup(page,{retire:route=>route.fulfill({status:403,json:{ok:false,code:'cross_site_forbidden'}}),read:route=>{
    if(new URL(route.request().url()).searchParams.has('binding_id')){reads++;held=route;return;}
    return route.fulfill({json:envelope('device_bindings',{customer_id:'A',items:[row],has_more:false,next_cursor:null})});
  }});
  await page.goto('/#/nodes');await page.getByRole('button',{name:'Disconnect',exact:true}).click();await page.getByRole('button',{name:'Disconnect device',exact:true}).click();
  const button=page.getByRole('button',{name:'Review current devices',exact:true});await expect(button).toBeVisible();
  await button.evaluate(element=>{element.click();element.click();});await expect.poll(()=>reads).toBe(1);
  await page.evaluate(()=>{location.hash='#/apps';});await expect(page.getByRole('heading',{name:'Connected devices'})).toHaveCount(0);
  await held.fulfill({json:envelope('device_bindings',{customer_id:'A',items:[{...row,state:'released',revision:1}],has_more:false,next_cursor:null})});
  await page.getByRole('link',{name:'Devices',exact:true}).click();await page.getByRole('button',{name:'Review disconnect request',exact:true}).click();
  await expect(page.getByRole('dialog')).toContainText('Example app · DEFAULT');await expect(page.getByRole('button',{name:'Clear saved request'})).toHaveCount(0);
  expect(await page.evaluate(()=>sessionStorage.getItem('licensecc.retirement.v1:A'))).not.toBeNull();
});
