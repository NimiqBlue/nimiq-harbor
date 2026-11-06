import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../src/server/index.js';
import { loadConfig } from '../src/server/config.js';
import { fusionConfig } from '../src/fusion/policy.js';
import { Store } from '../src/server/store.js';

test('no credentials: real API initializes, execution is disabled, no network needed', async () => {
  const app = createApp({ env: { APP_ORIGIN: 'http://localhost:14173' }, dbPath: ':memory:', fetch: async () => { throw new Error('Network forbidden'); } });
  try {
    const health = await app.inject('/api/health');
    assert.equal(health.statusCode, 200);
    assert.equal(health.json().configured, false);
    const session = await app.inject('/api/fusion/session');
    assert.equal(session.statusCode, 200);
    assert.equal(typeof session.json().csrfToken, 'string');
    assert.equal(fusionConfig({}).executionEnabled, false);
  } finally { await app.close(); }
});
test('unsafe execution configuration fails closed; secrets stay server-side', () => {
  assert.throws(() => fusionConfig({ FUSION_EXECUTION_ENABLED: 'true' }));
  assert.throws(() => loadConfig({ APP_ORIGIN: 'http://example.invalid' }));
  assert.throws(() => loadConfig({ TOKEN_ENCRYPTION_KEY: 'placeholder' }));
});

test('retired bank/OAuth API routes are absent and never call a provider', async () => {
  let calls = 0;
  const app = createApp({env:{APP_ORIGIN:'http://localhost:14173'},dbPath:':memory:',fetch:async()=>{calls++;throw new Error('Network forbidden');}});
  try {
    const session = await app.inject('/api/fusion/session');
    assert.deepEqual(Object.keys(session.json()), ['csrfToken']);
    const cookie = session.headers['set-cookie']!.toString().split(';')[0]!;
    const headers = {cookie,origin:'http://localhost:14173','x-csrf-token':session.json().csrfToken,'content-type':'application/json'};
    for (const url of ['/api/session','/api/auth/callback?state=old','/api/context','/api/profiles/00000000-0000-4000-8000-000000000000','/api/ibans','/api/activity','/api/redemptions/00000000-0000-4000-8000-000000000000','/api/bank/readiness']) {
      assert.equal((await app.inject({url,headers:{cookie}})).statusCode,404,url);
    }
    for (const url of ['/api/auth/start','/api/logout','/api/ibans/request','/api/wallet/link','/api/redemptions/prepare','/api/redemptions/00000000-0000-4000-8000-000000000000/submit']) {
      assert.equal((await app.inject({method:'POST',url,headers,payload:{}})).statusCode,404,url);
    }
    assert.equal(calls,0);
  } finally {await app.close();}
});

test('Fusion session preserves cookie, origin, CSRF, JSON, expiry and rate-limit guards', async () => {
  let now = 0;
  const app = createApp({env:{APP_ORIGIN:'https://harbor.example',HARBOR_SESSION_NAMESPACE:'swap'},dbPath:':memory:',now:()=>now,fetch:async()=>{throw new Error('Network forbidden');}});
  try {
    const session = await app.inject('/api/fusion/session');
    const setCookie=session.headers['set-cookie']!.toString();
    assert.match(setCookie,/^__Host-harbor-swap=/);
    for (const flag of ['Path=/','HttpOnly','SameSite=Lax','Secure']) assert.ok(setCookie.includes(flag),flag);
    assert.equal(session.headers['cache-control'],'no-store');
    const cookie=setCookie.split(';')[0]!;
    const headers={cookie,origin:'https://harbor.example','x-csrf-token':session.json().csrfToken,'content-type':'application/json'};
    const post=(extra:Record<string,string>={})=>app.inject({method:'POST',url:'/api/fusion/quotes',headers:{...headers,...extra},payload:'{}'});
    assert.equal((await post({'x-csrf-token':'wrong'})).statusCode,403);
    assert.equal((await post({origin:'https://attacker.invalid'})).statusCode,403);
    assert.equal((await post({'sec-fetch-site':'cross-site'})).statusCode,403);
    assert.equal((await post({'content-type':'text/plain'})).statusCode,415);
    assert.equal((await post()).statusCode,400,'valid session reaches strict quote validation');
    now=loadConfig({}).sessionTtl;
    assert.equal((await post()).statusCode,401,'expired session cannot mutate');
    let result=await app.inject('/api/health');
    for(let i=0;i<120;i++) result=await app.inject('/api/health');
    assert.equal(result.statusCode,429);
    assert.equal(result.headers['retry-after'],'60');
  } finally {await app.close();}
});

test('execution still requires every security prerequisite', () => {
  const env={APP_ORIGIN:'https://harbor.example',ONEINCH_API_KEY:'synthetic',TOKEN_ENCRYPTION_KEY:Buffer.alloc(32,7).toString('base64'),FUSION_EXECUTION_ENABLED:'true',POLYGON_RPC_URL:'https://rpc.example.invalid'};
  assert.equal(fusionConfig(env).executionEnabled,true);
  assert.equal(loadConfig(env).durableSessions,true);
  for(const key of ['APP_ORIGIN','ONEINCH_API_KEY','TOKEN_ENCRYPTION_KEY','POLYGON_RPC_URL']) {
    assert.throws(()=>fusionConfig({...env,[key]:''}),key);
  }
  for(const rpc of ['http://rpc.example.invalid','https://user:password@rpc.example.invalid','https://rpc.example.invalid/#fragment']) {
    assert.throws(()=>fusionConfig({...env,POLYGON_RPC_URL:rpc}));
  }
});

test('encrypted sessions expose only current fields; archived payment data is retained', () => {
  const store=new Store(':memory:',Buffer.alloc(32,7));
  try {
    store.db.prepare('INSERT INTO sessions VALUES(?,?,?)').run('old',100,store.seal({csrf:'csrf',expiresAt:100,tokens:{access_token:'retired'},oauth:{verifier:'retired'}},'session:old'));
    store.db.prepare('INSERT INTO intents VALUES(?,?,?,?)').run('archived','old','uncertain','retained');
    assert.deepEqual(store.session('old',0),{csrf:'csrf',expiresAt:100});
    assert.equal(store.session('old',100),undefined);
    assert.equal(store.db.prepare('SELECT data FROM intents WHERE id=?').get('archived')?.data,'retained');
    const sealed=store.seal({csrf:'secret'},'session:a');
    assert.ok(!sealed.includes('secret'));
    assert.throws(()=>store.unseal(sealed,'session:b'));
  } finally {store.close();}
});
