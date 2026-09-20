import { expect, test } from "@playwright/test";
import { entitlementId } from "@licensecc/licensing-domain/entitlements/contracts";

const handle = "E".repeat(42) + "A";
const storageKey = "licensecc.enrollment.v1";
const entry = `/connect#attempt_handle=${handle}`;
const callback = `http://127.0.0.1:44888/callback?code=${"I".repeat(42)}A&state=${"M".repeat(42)}A`;
const envelope = (code, data) => ({ ok: true, code, data, request_id: "consent-browser-test" });
const inspection = (overrides = {}) => ({
  app: { name: "Colmap", project: "COLMAP" }, device: { label: "My workstation" },
  status: "pending", revision: 0, expires_at: Math.floor(Date.now() / 1000) + 300,
  entitlements: [
    { id: "license-basic", feature: "BASIC", valid_until: null, device_limit: 1 },
    { id: "license-pro", feature: "PRO", valid_until: null, device_limit: 2 },
  ], has_more: false, next_page_cursor:null, comparison_code:"0000-1111-2222", ...overrides,
});

async function approve(page){
  await page.getByRole("checkbox",{name:"This code matches my app",exact:true}).check();
  await page.getByRole("button",{name:"Approve",exact:true}).click();
}

async function fixture(page, { signedIn = true, inspect, approve, deny, logout } = {}) {
  const state = { signedIn, customer: "customer-a", requests: [], logins: [] };
  await page.route("**/portal/v1/auth/**", async route => {
    const request = route.request(), path = new URL(request.url()).pathname;
    if (path.endsWith("/providers")) return route.fulfill({ json: envelope("auth_providers", { password: true, github: true, google: false, email: false }) });
    if (path.endsWith("/password/login")) {
      state.logins.push(request.postDataJSON()); state.signedIn = true;
      return route.fulfill({ json: envelope("signed_in", { customer_id: state.customer }) });
    }
    if (path.endsWith("/logout")) { if(logout)return logout(route,state);state.signedIn = false; return route.fulfill({ json: envelope("signed_out", {}) }); }
    if (path.endsWith("/github/start")) {
      state.signedIn = true;
      return route.fulfill({ status: 303, headers: { location: "/" }, body: "" });
    }
    throw new Error(`Unexpected consent auth route: ${path}`);
  });
  await page.route("**/api/portal/**", async route => {
    const request = route.request(), path = new URL(request.url()).pathname;
    state.requests.push({ path, url: request.url(), referer: request.headers().referer });
    if (!state.signedIn) return route.fulfill({ status: 401, json: { ok: false, code: "unauthorized" } });
    if (path.endsWith("/me")) return route.fulfill({ json: envelope("ok", { customer_id: state.customer }) });
    if(path.includes("/device-authorizations/") && request.headers()["x-expected-customer-id"]!==encodeURIComponent(state.customer)) return route.fulfill({status:409,json:{ok:false,code:"account_changed"}});
    if (path.endsWith("/inspect")) return inspect ? inspect(route, state) : route.fulfill({ json: envelope("authorization_inspected", inspection()) });
    if (path.endsWith("/approve")) return approve ? approve(route, state) : route.fulfill({ json: envelope("authorization_approved", { callback_url: callback, expires_at: Math.floor(Date.now()/1000)+60, revision: 1 }) });
    if (path.endsWith("/deny")) return deny ? deny(route, state) : route.fulfill({ json: envelope("authorization_denied", { status: "authorization_denied", revision: 1 }) });
    return route.fulfill({ json: envelope("ok", { items: [] }) });
  });
  return state;
}

test("consent: an unstarted trial explains activation timing without claiming no expiry",async({page})=>{
  await fixture(page,{inspect:route=>route.fulfill({json:envelope('authorization_inspected',inspection({
    entitlements:[{id:'trial',feature:'DEFAULT',valid_until:null,device_limit:1,activation_trial_seconds:86400}]
  }))})});
  await page.goto(entry);
  await expect(page.getByText('1 day from app activation. Approving here does not start the trial.')).toBeVisible();
  await expect(page.getByText('No expiry',{exact:true})).toHaveCount(0);
  await expect(page.getByRole('button',{name:'Approve',exact:true})).toBeDisabled();
});

test("consent: password login retains the attempt without leaking it into navigation or credentials", async ({ page }) => {
  const state = await fixture(page, { signedIn: false });
  await page.goto(entry);
  await expect(page.getByText("Sign in to approve this device connection.")).toBeVisible();
  expect(new URL(page.url()).hash).toBe("");
  await page.getByLabel("Email", { exact: true }).fill("customer@example.com");
  await page.getByLabel("Password", { exact: true }).fill("A test password for browser 1!");
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(page.getByRole("combobox", { name: "License", exact: true })).toBeVisible();
  expect(state.logins).toEqual([{ email: "customer@example.com", password: "A test password for browser 1!" }]);
  expect(JSON.stringify(state.requests)).not.toContain(handle);
  expect(await page.locator("body").innerHTML()).not.toContain(handle);
  expect(state.requests.every(r => r.path.endsWith("/me") || r.path.endsWith("/inspect"))).toBe(true);
  expect(await page.evaluate(() => localStorage.length)).toBe(0);
});

test("consent: same-tab social sign-in resumes after full navigation", async ({ page }) => {
  await fixture(page, { signedIn: false });
  await page.goto(entry);
  await page.getByText("Other sign-in options", { exact: true }).click();
  await page.getByRole("button", { name: "Continue with GitHub" }).click();
  await expect(page.getByRole("combobox", { name: "License", exact: true })).toBeVisible();
  expect(new URL(page.url()).hash).toBe("");
  expect(await page.evaluate(key => JSON.parse(sessionStorage.getItem(key)).handle, storageKey)).toBe(handle);
});

test("consent: lost approval response and reload preserve the exact mutation and choice", async ({ page }) => {
  const attempts = [];
  await fixture(page, {
    inspect: route => route.fulfill({ json: envelope("authorization_inspected", inspection(attempts.length ? { status: "approved", revision: 1, entitlements: [] } : {})) }),
    approve: route => {
      attempts.push({ body: route.request().postDataJSON(), key: route.request().headers()["idempotency-key"] });
      return attempts.length === 1
        ? route.fulfill({ status: 503, json: { ok: false, code: "temporarily_unavailable" } })
        : route.fulfill({ json: envelope("authorization_approved", { callback_url: callback, expires_at: Math.floor(Date.now()/1000)+60, revision: 1 }) });
    },
  });
  await page.route("http://127.0.0.1:44888/**", route => route.fulfill({ contentType: "text/html", body: "<h1>App callback received</h1>" }));
  await page.goto(entry);
  await page.getByRole("combobox", { name: "License", exact: true }).selectOption("license-pro");
  await approve(page);
  await expect(page.getByRole("button", { name: "Retry approval" })).toBeVisible();
  await page.goto(entry);
  await expect(page.getByRole("button", { name: "Retry approval" })).toBeVisible();
  await page.reload();
  await expect(page.getByRole("button", { name: "Retry approval" })).toBeEnabled();
  await expect(page.getByRole("combobox", { name: "License", exact: true })).toHaveCount(0);
  expect(await page.evaluate(key => sessionStorage.getItem(key), storageKey)).not.toContain("callback_url");
  await page.getByRole("button", { name: "Retry approval" }).click();
  await expect(page.getByRole("heading", { name: "App callback received" })).toBeVisible();
  expect(attempts).toHaveLength(2);
  expect(attempts[1]).toEqual(attempts[0]);
  expect(attempts[0].body).toEqual({ attempt_handle: handle, expected_attempt_revision: 0, entitlement_id: "license-pro" });
  expect(attempts[0].key).toMatch(/^[A-Za-z0-9_-]{16,128}$/);
});

test("consent: cancellation clears enrollment and mobile layout fits", async ({ page }) => {
  await fixture(page);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(entry);
  await expect(page.getByRole("combobox", { name: "License", exact: true })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.getByRole("button", { name: "Cancel", exact: true }).focus();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("heading", { name: "Connection cancelled" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Connection cancelled" })).toBeFocused();
  expect(await page.evaluate(key => sessionStorage.getItem(key), storageKey)).toBeNull();
  await page.getByRole("button", { name: "Go to portal" }).click();
  await expect(page.getByRole("heading", { name: "Apps", exact: true })).toBeVisible();
});

test("consent: sign-out clears the attempt and another account cannot reuse a saved choice", async ({ page }) => {
  const state = await fixture(page);
  await page.goto(entry);
  await expect(page.getByRole("combobox", { name: "License", exact: true })).toBeVisible();
  state.customer = "customer-b";
  await page.reload();
  await expect(page.getByText("Your account changed. Start a new connection from your app.")).toBeVisible();
  expect(await page.evaluate(key => sessionStorage.getItem(key), storageKey)).toBeNull();
  await page.goto(entry);
  await expect(page.getByRole("combobox", { name: "License", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Sign out", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Sign in", exact: true })).toBeVisible();
  expect(await page.evaluate(key => sessionStorage.getItem(key), storageKey)).toBeNull();
});

test("consent: malformed handles are scrubbed and never inspected", async ({ page }) => {
  const state = await fixture(page);
  for (const url of [`/connect?attempt_handle=${handle}`, `${entry}&attempt_handle=${handle}`, "/connect#unexpected=secret"]) {
    await page.goto(url);
    await expect(page.getByRole("heading", { name: "Connection request expired" })).toBeVisible();
    expect(new URL(page.url()).hash).toBe("");
    expect(new URL(page.url()).search).toBe("");
  }
  expect(state.requests.some(r => r.path.endsWith("/inspect"))).toBe(false);
});

test("consent: unavailable session storage gives an actionable error after fragment removal", async ({ page }) => {
  await page.addInitScript(() => { Storage.prototype.setItem = () => { throw new DOMException("denied", "SecurityError"); }; });
  const state = await fixture(page);
  await page.goto(entry);
  await expect(page.getByRole("alert")).toContainText("Browser session storage is unavailable");
  expect(new URL(page.url()).hash).toBe("");
  expect(state.requests.some(r => r.path.endsWith("/inspect"))).toBe(false);
});

test("consent: malformed approval stays on portal and throttled retry waits", async ({ page }) => {
  let attempts = 0;
  await fixture(page, { approve: route => ++attempts === 1
    ? route.fulfill({ json: envelope("authorization_approved", { callback_url: "https://evil.example/", expires_at: 1, revision: 1 }) })
    : route.fulfill({ status: 429, headers: { "retry-after": "60" }, json: { ok: false, code: "rate_limited" } }),
  });
  await page.goto(entry);
  await page.getByRole("combobox", { name: "License", exact: true }).selectOption("license-pro");
  await approve(page);
  await page.getByRole("button", { name: "Retry approval" }).click();
  await expect(page.getByRole("alert")).toContainText("Too many attempts");
  await expect(page.getByRole("button", { name: "Retry approval" })).toBeDisabled();
  expect(new URL(page.url()).pathname).toBe("/connect");
});

for(const action of ["Approve","Cancel"]) test(`consent: ${action} rejects an account change without reloading`, async ({page})=>{
  let mutations=0;
  const state=await fixture(page,{approve:()=>{mutations++;throw new Error("Changed account reached approval");},deny:()=>{mutations++;throw new Error("Changed account reached denial");}});
  await page.goto(entry);
  await page.getByRole("combobox",{name:"License",exact:true}).selectOption("license-pro");
  state.customer="customer-b";
  if(action==="Approve")await approve(page);else await page.getByRole("button",{name:action,exact:true}).click();
  await expect(page.getByRole("alert")).toHaveText("Your account changed. Start a new connection from your app.");
  expect(mutations).toBe(0);
  expect(await page.evaluate(key=>sessionStorage.getItem(key),storageKey)).toBeNull();
});

test("consent: pending sign-out disables consent mutations", async ({page})=>{
  let releaseLogout;
  let signalStarted;
  const started=new Promise(resolve=>{signalStarted=resolve;});
  await fixture(page,{logout:async(route,state)=>{
    signalStarted();await new Promise(resolve=>{releaseLogout=resolve;});
    state.signedIn=false;return route.fulfill({json:envelope("signed_out",{})});
  }});
  await page.goto(entry);
  await page.getByRole("combobox",{name:"License",exact:true}).selectOption("license-pro");
  await page.getByRole("button",{name:"Sign out",exact:true}).click();
  await started;
  try {
    await expect(page.getByRole("button",{name:"Cancel",exact:true})).toBeDisabled();
    await expect(page.getByRole("button",{name:"Sign out",exact:true})).toBeDisabled();
    await expect(page.locator(".consentActions .primary")).toBeDisabled();
  } finally {releaseLogout();}
  await expect(page.getByRole("heading",{name:"Sign in",exact:true})).toBeVisible();
});

test("consent: expiry equality removes actions, clears state and focuses restart guidance", async ({page})=>{
  const now=Math.floor(Date.now()/1000)*1000;
  await page.clock.install({time:new Date(now)});
  await fixture(page,{inspect:route=>route.fulfill({json:envelope("authorization_inspected",inspection({expires_at:now/1000+2}))})});
  await page.goto(entry);
  await expect(page.getByRole("combobox",{name:"License",exact:true})).toBeVisible();
  await page.clock.fastForward(2000);
  await expect(page.getByRole("heading",{name:"Connection request expired"})).toBeFocused();
  await expect(page.getByRole("button",{name:"Approve",exact:true})).toHaveCount(0);
  expect(await page.evaluate(key=>sessionStorage.getItem(key),storageKey)).toBeNull();
});

test("consent: expired delayed approval never navigates to the callback", async ({page})=>{
  let navigations=0;
  await page.route("http://127.0.0.1:44888/**",route=>{navigations++;return route.fulfill({status:204});});
  await fixture(page,{approve:route=>route.fulfill({json:envelope("authorization_approved",{callback_url:callback,expires_at:Math.floor(Date.now()/1000)-1,revision:1})})});
  await page.goto(entry);
  await page.getByRole("combobox",{name:"License",exact:true}).selectOption("license-pro");
  await approve(page);
  await expect(page.getByRole("heading",{name:"Connection request expired"})).toBeVisible();
  expect(navigations).toBe(0);
});

test("consent: resuming an approved page after expiry removes its in-memory callback", async ({page})=>{
  const now=Math.floor(Date.now()/1000)*1000;
  await page.clock.install({time:new Date(now)});
  await page.route("http://127.0.0.1:44888/**",route=>route.fulfill({status:204}));
  await fixture(page,{approve:route=>route.fulfill({json:envelope("authorization_approved",{callback_url:callback,expires_at:now/1000+2,revision:1})})});
  await page.goto(entry);
  await page.getByRole("combobox",{name:"License",exact:true}).selectOption("license-pro");
  await approve(page);
  await expect(page.getByRole("link",{name:"Open app"})).toBeVisible();
  await page.clock.setSystemTime(now+2000);
  await page.evaluate(()=>window.dispatchEvent(new PageTransitionEvent("pageshow")));
  await expect(page.getByRole("heading",{name:"Connection request expired"})).toBeVisible();
  await expect(page.getByRole("link",{name:"Open app"})).toHaveCount(0);
  expect(await page.locator("body").innerHTML()).not.toContain("callback?code=");
});

for(const corrupt of ["expired","null-mutation","unknown-field","unbound-mutation"]) test(`consent: ${corrupt} saved enrollment is discarded before inspection`,async({page})=>{
  await page.addInitScript(({key,handle,corrupt})=>{
    sessionStorage.setItem(key,JSON.stringify({handle,createdAt:Date.now()-(corrupt==="expired"?300000:0),...(corrupt==="null-mutation"?{mutation:null}:{}),...(corrupt==="unknown-field"?{callback_url:"secret"}:{}),...(corrupt==="unbound-mutation"?{mutation:{operation:"deny",key:"operation_123456789",revision:0}}:{})}));
  },{key:storageKey,handle,corrupt});
  const state=await fixture(page);
  await page.goto("/connect");
  await expect(page.getByRole("heading",{name:"Connection request expired"})).toBeVisible();
  expect(state.requests.some(r=>r.path.endsWith("/inspect"))).toBe(false);
  expect(await page.evaluate(key=>sessionStorage.getItem(key),storageKey)).toBeNull();
});

test("consent: otherwise identical licenses remain distinguishable",async({page})=>{
  await fixture(page,{inspect:route=>route.fulfill({json:envelope("authorization_inspected",inspection({entitlements:[
    {id:"license-a",feature:"PRO",valid_until:null,device_limit:1},
    {id:"license-b",feature:"PRO",valid_until:null,device_limit:3},
  ]}))})});
  await page.goto(entry);
  await expect(page.getByRole("option",{name:"1. PRO — license-a",exact:true})).toHaveCount(1);
  await expect(page.getByRole("option",{name:"2. PRO — license-b",exact:true})).toHaveCount(1);
  await page.getByRole("combobox",{name:"License",exact:true}).selectOption("license-b");
  await expect(page.getByText("3 devices",{exact:true})).toBeVisible();
});

test("consent: failed loopback handoff allows Back and exact approval recovery",async({page})=>{
  const attempts=[];
  let callbacks=0;
  await page.route("http://127.0.0.1:44888/**",route=>++callbacks===1?route.abort("connectionrefused"):route.fulfill({contentType:"text/html",body:"<h1>Recovered app callback</h1>"}));
  await fixture(page,{
    inspect:route=>route.fulfill({json:envelope("authorization_inspected",inspection(attempts.length?{status:"approved",revision:1,entitlements:[]}:{}))}),
    approve:route=>{attempts.push({body:route.request().postDataJSON(),key:route.request().headers()["idempotency-key"]});return route.fulfill({json:envelope("authorization_approved",{callback_url:callback,expires_at:Math.floor(Date.now()/1000)+60,revision:1})});},
  });
  await page.goto(entry);
  await page.getByRole("combobox",{name:"License",exact:true}).selectOption("license-pro");
  const failed=page.waitForEvent("requestfailed",r=>r.url().startsWith("http://127.0.0.1:44888/"));
  const errorPage=page.waitForEvent("framenavigated",frame=>frame===page.mainFrame() && !frame.url().includes(":4174"));
  await approve(page);
  await failed;
  await errorPage;
  await page.waitForLoadState("domcontentloaded");
  await page.goBack();
  await expect(page).toHaveURL(/\/connect$/);
  // Reload also covers restoration without a surviving in-memory callback.
  await page.reload();
  await page.getByRole("button",{name:"Retry approval"}).click();
  await expect(page.getByRole("heading",{name:"Recovered app callback"})).toBeVisible();
  expect(attempts).toHaveLength(2);expect(attempts[1]).toEqual(attempts[0]);
});

test("consent: an authenticated consumed result remains connected after attempt expiry",async({page})=>{
  await fixture(page,{inspect:route=>route.fulfill({json:envelope("authorization_inspected",inspection({status:"consumed",expires_at:1,entitlements:[]}))})});
  await page.goto(entry);
  await expect(page.getByRole("heading",{name:"Device connected"})).toBeFocused();
  expect(await page.evaluate(key=>sessionStorage.getItem(key),storageKey)).toBeNull();
});

for(const [status,code] of [[400,"invalid_request"],[403,"cross_site_forbidden"]]) test(`consent: ${code} gives terminal restart guidance`,async({page})=>{
  await fixture(page,{inspect:route=>route.fulfill({status,json:{ok:false,code}})});
  await page.goto(entry);
  await expect(page.getByRole("alert")).toContainText("Restart from your app");
  await expect(page.getByRole("button",{name:"Retry",exact:true})).toHaveCount(0);
  expect(await page.evaluate(key=>sessionStorage.getItem(key),storageKey)).toBeNull();
});

test("consent: a failed sign-out remains visible and preserves the request",async({page})=>{
  await fixture(page,{logout:route=>route.fulfill({status:503,json:{ok:false,code:"temporarily_unavailable"}})});
  await page.goto(entry);
  await expect(page.getByRole("combobox",{name:"License",exact:true})).toBeVisible();
  await page.getByRole("button",{name:"Sign out",exact:true}).click();
  await expect(page.locator(".statusline.error")).toBeVisible();
  await expect(page.getByRole("button",{name:"Sign out",exact:true})).toBeEnabled();
  expect(await page.evaluate(key=>sessionStorage.getItem(key),storageKey)).not.toBeNull();
});

for(const sameAccount of [true,false]) test(`consent: reauthentication ${sameAccount?"retains exact retry":"discards another account's retry"}`,async({page})=>{
  const attempts=[];
  const state=await fixture(page,{
    inspect:route=>route.fulfill({json:envelope("authorization_inspected",inspection(attempts.length?{status:"approved",revision:1,entitlements:[]}:{}))}),
    approve:(route,current)=>{
      attempts.push({body:route.request().postDataJSON(),key:route.request().headers()["idempotency-key"]});
      if(attempts.length===1){current.signedIn=false;return route.fulfill({status:401,json:{ok:false,code:"unauthorized"}});}
      return route.fulfill({json:envelope("authorization_approved",{callback_url:callback,expires_at:Math.floor(Date.now()/1000)+60,revision:1})});
    },
  });
  await page.route("http://127.0.0.1:44888/**",route=>route.fulfill({status:204}));
  await page.goto(entry);
  await page.getByRole("combobox",{name:"License",exact:true}).selectOption("license-pro");
  await approve(page);
  await expect(page.getByRole("heading",{name:"Sign in",exact:true})).toBeVisible();
  if(!sameAccount)state.customer="customer-b";
  await page.getByLabel("Email",{exact:true}).fill("customer@example.com");
  await page.getByLabel("Password",{exact:true}).fill("A test passphrase 123!");
  await page.getByRole("button",{name:"Sign in",exact:true}).click();
  if(sameAccount){
    await page.getByRole("button",{name:"Retry approval"}).click();
    await expect(page.getByRole("link",{name:"Open app"})).toBeVisible();
    expect(attempts).toHaveLength(2);expect(attempts[1]).toEqual(attempts[0]);
  } else {
    await expect(page.getByRole("alert")).toContainText("Your account changed");
    expect(attempts).toHaveLength(1);
    expect(await page.evaluate(key=>sessionStorage.getItem(key),storageKey)).toBeNull();
  }
});

test("consent: a new link refreshes account identity after a no-reload account change",async({page})=>{
  const state=await fixture(page);
  await page.goto(entry);
  await expect(page.getByRole("combobox",{name:"License",exact:true})).toBeVisible();
  state.customer="customer-b";
  await page.getByRole("button",{name:"Cancel",exact:true}).click();
  await expect(page.getByRole("alert")).toContainText("Your account changed");
  await page.goto(`/connect#attempt_handle=${"Q".repeat(42)}A`);
  await expect(page.getByRole("combobox",{name:"License",exact:true})).toBeVisible();
  await expect(page.getByText("customer-b",{exact:true})).toBeVisible();
});

test("consent: a late approval from an old attempt cannot redirect or erase a new one",async({page})=>{
  let releaseApproval,signalStarted;
  const started=new Promise(resolve=>{signalStarted=resolve;});
  let callbacks=0;
  await page.route("http://127.0.0.1:44888/**",route=>{callbacks++;return route.fulfill({status:204});});
  await fixture(page,{approve:async route=>{
    signalStarted();await new Promise(resolve=>{releaseApproval=resolve;});
    return route.fulfill({json:envelope("authorization_approved",{callback_url:callback,expires_at:Math.floor(Date.now()/1000)+60,revision:1})});
  }});
  await page.goto(entry);
  await page.getByRole("combobox",{name:"License",exact:true}).selectOption("license-pro");
  await approve(page);
  await started;
  const nextHandle="Q".repeat(42)+"A";
  try {
    await page.goto(`/connect#attempt_handle=${nextHandle}`);
    await expect(page.getByRole("combobox",{name:"License",exact:true})).toBeEnabled();
  } finally {releaseApproval();}
  await page.waitForResponse(r=>r.url().endsWith("/approve"));
  await expect(page.getByRole("heading",{name:"Connect this device",exact:true})).toBeVisible();
  expect(callbacks).toBe(0);
  expect(await page.evaluate(key=>JSON.parse(sessionStorage.getItem(key)).handle,storageKey)).toBe(nextHandle);
});

test("consent: real encoded license references stay readable on mobile",async({page})=>{
  const project="A_LONG_PROJECT_".repeat(12),fingerprints=["a".repeat(52)+"000000000001","a".repeat(52)+"000000000002"];
  const ids=fingerprints.map(fp=>entitlementId(project,"PRO",fp));
  await fixture(page,{inspect:route=>route.fulfill({json:envelope("authorization_inspected",inspection({entitlements:ids.map(id=>({id,feature:"PRO",valid_until:null,device_limit:2}))}))})});
  await page.setViewportSize({width:390,height:844});
  await page.goto(entry);
  await expect(page.getByRole("option",{name:"1. PRO — …000000000001",exact:true})).toHaveCount(1);
  await expect(page.getByRole("option",{name:"2. PRO — …000000000002",exact:true})).toHaveCount(1);
  await page.getByRole("combobox",{name:"License",exact:true}).selectOption(ids[1]);
  await expect(page.getByText(fingerprints[1],{exact:true})).toBeHidden();
  await page.locator(".consentSummary summary").click();
  await expect(page.getByText(fingerprints[1],{exact:true})).toBeVisible();
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
});

const firstLicensePage=()=>Array.from({length:100},(_,i)=>({id:`license-${i+1}`,feature:"PRO",valid_until:null,device_limit:1}));
const pageTwoCursor=Buffer.from(JSON.stringify(["ep1","a".repeat(64),"b".repeat(64),"DEFAULT","c".repeat(64)])).toString("base64url");
const laterLicense={id:"license-101",feature:"PRO",valid_until:null,device_limit:2};
test("consent: malformed next cursors fail before page navigation",async({page})=>{
  await fixture(page,{inspect:route=>route.fulfill({json:envelope("authorization_inspected",inspection({entitlements:firstLicensePage(),has_more:true,next_page_cursor:"cGFnZTI"}))})});
  await page.goto(entry);
  await expect(page.getByRole("alert")).toHaveText("We couldn’t load this request. Please try again.");
  await expect(page.getByRole("button",{name:"Next",exact:true})).toHaveCount(0);
  await expect(page.getByRole("button",{name:"Approve",exact:true})).toHaveCount(0);
});

test("consent: Previous and Next keep one page and clear successful navigation selection",async({page})=>{
  const requests=[];
  await fixture(page,{inspect:route=>{
    const cursor=route.request().postDataJSON().page_cursor;requests.push(cursor??null);
    return route.fulfill({json:envelope("authorization_inspected",inspection(cursor?{entitlements:[laterLicense]}:{entitlements:firstLicensePage(),has_more:true,next_page_cursor:pageTwoCursor}))});
  }});
  await page.goto(entry);
  await page.getByRole("combobox",{name:"License",exact:true}).selectOption("license-5");
  await page.getByRole("checkbox",{name:"This code matches my app"}).check();
  await page.getByRole("button",{name:"Next",exact:true}).click();
  await expect(page.getByText("Page 2",{exact:true})).toBeVisible();
  await expect(page.getByRole("combobox",{name:"License",exact:true})).toHaveValue("");
  await expect(page.getByRole("option")).toHaveCount(2);
  await expect(page.getByRole("button",{name:"Approve",exact:true})).toBeDisabled();
  await page.getByRole("combobox",{name:"License",exact:true}).focus();
  await page.getByRole("combobox",{name:"License",exact:true}).press("ArrowDown");
  await expect(page.getByRole("combobox",{name:"License",exact:true})).toHaveValue("license-101");
  await expect(page.getByRole("combobox",{name:"License",exact:true})).toBeFocused();
  await page.getByRole("button",{name:"Previous",exact:true}).click();
  await expect(page.getByText("Page 1",{exact:true})).toBeVisible();
  await expect(page.getByRole("combobox",{name:"License",exact:true})).toHaveValue("");
  await expect(page.getByRole("option")).toHaveCount(101);
  expect(requests).toEqual([null,pageTwoCursor,null]);
});

for(const status of [429,503])test(`consent: failed page ${status} preserves the current selection and page`,async({page})=>{
  await fixture(page,{inspect:route=>route.request().postDataJSON().page_cursor
    ?route.fulfill({status,headers:{"retry-after":"60"},json:{ok:false,code:status===429?"rate_limited":"temporarily_unavailable"}})
    :route.fulfill({json:envelope("authorization_inspected",inspection({entitlements:firstLicensePage(),has_more:true,next_page_cursor:pageTwoCursor}))})});
  await page.goto(entry);
  await page.getByRole("combobox",{name:"License",exact:true}).selectOption("license-5");
  await page.getByRole("checkbox",{name:"This code matches my app"}).check();
  await page.getByRole("button",{name:"Next",exact:true}).click();
  await expect(page.getByRole("alert")).toBeVisible();
  await expect(page.getByText("Page 1",{exact:true})).toBeVisible();
  await expect(page.getByRole("combobox",{name:"License",exact:true})).toHaveValue("license-5");
  await expect(page.getByRole("option")).toHaveCount(101);
  await expect(page.getByRole("checkbox",{name:"This code matches my app"})).toBeChecked();
  if(status===429)await expect(page.getByRole("button",{name:"Next",exact:true})).toBeDisabled();
});

test("consent: comparison mismatch can cancel but cannot approve without confirmation",async({page})=>{
  await fixture(page);await page.goto(entry);
  await page.getByRole("combobox",{name:"License",exact:true}).selectOption("license-pro");
  await expect(page.getByText("0000-1111-2222",{exact:true})).toBeVisible();
  await expect(page.getByRole("button",{name:"Approve",exact:true})).toBeDisabled();
  const checkbox=page.getByRole("checkbox",{name:"This code matches my app"});
  await checkbox.focus();await page.keyboard.press("Space");
  await expect(page.getByRole("button",{name:"Approve",exact:true})).toBeEnabled();
  await page.keyboard.press("Space");
  await expect(page.getByRole("button",{name:"Approve",exact:true})).toBeDisabled();
  await page.getByRole("button",{name:"Cancel",exact:true}).click();
  await expect(page.getByRole("heading",{name:"Connection cancelled"})).toBeVisible();
});

test("consent: a changed comparison code cannot reuse a saved approval",async({page})=>{
  let comparison="0000-1111-2222";
  await fixture(page,{inspect:route=>route.fulfill({json:envelope("authorization_inspected",inspection({comparison_code:comparison}))}),
    approve:route=>route.fulfill({status:503,json:{ok:false,code:"temporarily_unavailable"}})});
  await page.goto(entry);
  await page.getByRole("combobox",{name:"License",exact:true}).selectOption("license-pro");
  await approve(page);
  await expect(page.getByRole("button",{name:"Retry approval"})).toBeVisible();
  comparison="AAAA-BBBB-CCCC";
  await page.reload();
  await expect(page.getByRole("alert")).toHaveText("This connection request changed. Restart from your app.");
  await expect(page.getByRole("button",{name:"Retry approval"})).toHaveCount(0);
  expect(await page.evaluate(key=>sessionStorage.getItem(key),storageKey)).toBeNull();
});

test("consent: cursor cycles and account changes cannot append a new page",async({page})=>{
  const state=await fixture(page,{inspect:route=>route.fulfill({json:envelope("authorization_inspected",inspection({entitlements:firstLicensePage(),has_more:true,next_page_cursor:pageTwoCursor}))})});
  await page.goto(entry);
  await page.getByRole("button",{name:"Next",exact:true}).click();
  await expect(page.getByRole("alert")).toContainText("next page safely");
  await expect(page.getByText("Page 1",{exact:true})).toBeVisible();
  state.customer="customer-b";
  await page.getByRole("button",{name:"Next",exact:true}).click();
  await expect(page.getByRole("alert")).toContainText("Your account changed");
  await expect(page.getByRole("navigation",{name:"License pages"})).toHaveCount(0);
});
