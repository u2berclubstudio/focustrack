process.env.MAIL_MODE='capture'; process.env.DATA_DIR='/tmp/ft-al'; process.env.ALERTS_API_KEY='test-key-123';
const assert=require('assert');
const app=require('./server');
const {db,hashPin,nowISO}=require('./db');
const mailer=require('./mailer');
const s=app.listen(0,async()=>{
  const base=`http://127.0.0.1:${s.address().port}`;
  const call=async(p,o={},t)=>{const r=await fetch(base+p,{...o,headers:{'Content-Type':'application/json',...(t?{Authorization:'Bearer '+t}:{})}});
    let b;const x=await r.text();try{b=JSON.parse(x)}catch{b=x}return{status:r.status,body:b}};
  const post=(p,b,t)=>call(p,{method:'POST',body:JSON.stringify(b||{})},t);
  const ok=m=>console.log('  OK '+m);
  try{
    for(const t of ['distractions','sessions','tokens','users','invite_codes','businesses','audit_log','login_guard','otp_challenges'])db.prepare(`DELETE FROM ${t}`).run();
    db.prepare(`INSERT INTO users (business_id,name,pin_hash,role,team,email,created_at) VALUES (NULL,?,?,'master','p',?,?)`).run('Atul',hashPin('481902'),'b@e.com',nowISO());
    const f=await post('/api/master/login',{name:'Atul',pin:'481902'});
    const c=mailer.sent.at(-1).text.match(/\b(\d{6})\b/)[1];
    const master=(await post('/api/master/otp',{challenge:f.body.challenge,code:c})).body.token;
    const inv=(await post('/api/master/codes',{seat_limit:10},master)).body.code;
    await post('/api/signup',{code:inv,business_name:'Acme',slug:'acme',owner_name:'Ravi',owner_pin:'481902',contact_email:'boss@acme.com'});
    const admin=(await post('/api/login',{slug:'acme',name:'Ravi',pin:'481902'})).body.token;
    await post('/api/admin/users',{name:'Neha',pin:'774411',team:'Sales'},admin);
    await post('/api/admin/users',{name:'Sam',pin:'905513',team:'Ops'},admin);
    const neha=(await post('/api/login',{slug:'acme',name:'Neha',pin:'774411'})).body.token;

    // defaults
    const st=await call('/api/admin/settings',{},admin);
    assert.strictEqual(st.status,200);
    assert.strictEqual(st.body.notification_interval,6);
    ok('a new workspace defaults to the 6-hour setting');

    // save + read back
    for(const v of [1,3,6,12]){
      assert.strictEqual((await call('/api/admin/settings',{method:'PATCH',body:JSON.stringify({notification_interval:v})},admin)).status,200);
      assert.strictEqual((await call('/api/admin/settings',{},admin)).body.notification_interval,v);
    }
    ok('all four choices save and read back');

    const bad=await call('/api/admin/settings',{method:'PATCH',body:JSON.stringify({notification_interval:5})},admin);
    assert.strictEqual(bad.status,400);
    assert.strictEqual((await call('/api/admin/settings',{},admin)).body.notification_interval,12);
    ok('a junk interval is refused and does not overwrite the saved one');

    // nobody logged yet -> everyone inactive
    let inact=(await call('/api/admin/inactive-members?hours=1',{},admin)).body;
    assert.deepStrictEqual(inact.inactive.map(m=>m.name).sort(),['Neha','Ravi','Sam']);
    ok('with no sessions at all, everyone shows as inactive');

    // Neha logs -> drops off the list
    const sid=(await post('/api/sessions/start',{task:'Work',planned_minutes:30},neha)).body.session.id;
    inact=(await call('/api/admin/inactive-members?hours=1',{},admin)).body;
    assert.ok(!inact.inactive.some(m=>m.name==='Neha'));
    assert.strictEqual(inact.inactive.length,2);
    ok('someone who just started a session drops off the list');

    // an OLD session must not count as recent activity
    db.prepare('UPDATE sessions SET started_at=? WHERE id=?').run(new Date(Date.now()-9*3600000).toISOString(),sid);
    inact=(await call('/api/admin/inactive-members?hours=1',{},admin)).body;
    assert.ok(inact.inactive.some(m=>m.name==='Neha'),'9h-old session should not count as active in a 1h window');
    ok('a session from hours ago does not count as recent activity');

    // the email needs a real "last seen" - this is what admins act on
    const n=inact.inactive.find(m=>m.name==='Neha');
    assert.ok(n.last_session_at,'last_session_at must show when Neha was last seen');
    ok('the list reports when each person was last seen');

    // window widens -> Neha counts again
    inact=(await call('/api/admin/inactive-members?hours=12',{},admin)).body;
    assert.ok(!inact.inactive.some(m=>m.name==='Neha'));
    ok('widening the window to 12h counts that session again');

    // tenant isolation
    const inv2=(await post('/api/master/codes',{},master)).body.code;
    await post('/api/signup',{code:inv2,business_name:'Globex',slug:'globex',owner_name:'Priya',owner_pin:'620744'});
    const other=(await post('/api/login',{slug:'globex',name:'Priya',pin:'620744'})).body.token;
    const o=(await call('/api/admin/inactive-members?hours=1',{},other)).body;
    assert.deepStrictEqual(o.inactive.map(m=>m.name),['Priya']);
    ok('one business never sees another business\'s people');

    assert.strictEqual((await call('/api/admin/settings',{},neha)).status,403);
    assert.strictEqual((await call('/api/admin/inactive-members?hours=1',{},neha)).status,403);
    ok('a normal team member cannot read the settings or the list');

    // ---- automation surface ----
    const key=k=>({headers:{'Content-Type':'application/json','X-Api-Key':k}});
    const kcall=async(p,o={},k='test-key-123')=>{const r=await fetch(base+p,{...o,headers:{'Content-Type':'application/json','X-Api-Key':k}});
      let b;const x=await r.text();try{b=JSON.parse(x)}catch{b=x}return{status:r.status,body:b}};

    assert.strictEqual((await call('/api/automation/alerts-due')).status,401);
    assert.strictEqual((await kcall('/api/automation/alerts-due',{},'wrong-key')).status,401);
    ok('the automation endpoint refuses a missing or wrong key');

    let d=(await kcall('/api/automation/alerts-due')).body.due;
    const acme=d.find(x=>x.slug==='acme');
    assert.ok(acme,'acme should be due on the first run');
    assert.strictEqual(acme.contactEmail,'boss@acme.com');
    assert.strictEqual(acme.intervalHours,12);
    assert.ok(acme.inactive.length>0);
    ok('a workspace that never got a reminder is due immediately');

    assert.ok(!d.some(x=>x.slug==='globex'),'globex has no contact email, so nobody to mail');
    ok('a workspace with no contact email is skipped, not crashed on');

    const upd=(await kcall('/api/automation/alerts-sent',{method:'POST',body:JSON.stringify({businessIds:[acme.businessId]})})).body;
    assert.strictEqual(upd.updated,1);
    assert.ok(!(await kcall('/api/automation/alerts-due')).body.due.some(x=>x.slug==='acme'));
    ok('once marked sent, that workspace goes quiet for its whole interval');

    db.prepare('UPDATE businesses SET last_inactive_notification_sent_at=? WHERE slug=?')
      .run(new Date(Date.now()-13*3600000).toISOString(),'acme');
    assert.ok((await kcall('/api/automation/alerts-due')).body.due.some(x=>x.slug==='acme'));
    ok('after the interval passes it becomes due again');

    db.prepare("UPDATE businesses SET status='suspended' WHERE slug=?").run('acme');
    assert.ok(!(await kcall('/api/automation/alerts-due')).body.due.some(x=>x.slug==='acme'));
    db.prepare("UPDATE businesses SET status='active' WHERE slug=?").run('acme');
    ok('a suspended workspace stops being emailed');

    assert.strictEqual((await kcall('/api/automation/alerts-sent',{method:'POST',body:JSON.stringify({businessIds:['x',null,99999]})})).body.updated,0);
    ok('junk ids in the sent-list update nothing and do not error');

    console.log('\nAlert checks passed.\n'); s.close(); process.exit(0);
  }catch(e){console.error('\nFAILED:',e.message);s.close();process.exit(1)}
});
