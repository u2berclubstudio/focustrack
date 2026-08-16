process.env.MAIL_MODE='capture'; process.env.ALERTS_API_KEY='test-key-123'; process.env.DATA_DIR='/tmp/ft-body';
const assert=require('assert'), fs=require('fs');
const app=require('./server');
const {db,hashPin,nowISO}=require('./db');
const mailer=require('./mailer');

const srv=app.listen(0,async()=>{
  const base=`http://127.0.0.1:${srv.address().port}`;
  const call=async(p,o={},t)=>{const r=await fetch(base+p,{...o,headers:{'Content-Type':'application/json',...(t?{Authorization:'Bearer '+t}:{})}});
    let b;const x=await r.text();try{b=JSON.parse(x)}catch{b=x}return{status:r.status,body:b}};
  const post=(p,b,t)=>call(p,{method:'POST',body:JSON.stringify(b||{})},t);
  const patch=(p,b,t)=>call(p,{method:'PATCH',body:JSON.stringify(b||{})},t);
  const ok=m=>console.log('  ✓ '+m);
  try{
    for(const t of ['plan_items','distractions','sessions','tokens','users','invite_codes','businesses','audit_log','login_guard','otp_challenges'])db.prepare(`DELETE FROM ${t}`).run();
    db.prepare(`INSERT INTO users (business_id,name,pin_hash,role,team,email,created_at) VALUES (NULL,?,?,'master','p',?,?)`).run('Atul',hashPin('481902'),'b@e.com',nowISO());
    const f=await post('/api/master/login',{name:'Atul',pin:'481902'});
    const c=mailer.sent.at(-1).text.match(/\b(\d{6})\b/)[1];
    const master=(await post('/api/master/otp',{challenge:f.body.challenge,code:c})).body.token;
    const inv=(await post('/api/master/codes',{seat_limit:20},master)).body.code;
    await post('/api/signup',{code:inv,business_name:'Acme Events',slug:'acme',owner_name:'Ravi',owner_pin:'481902',contact_email:'boss@acme.com'});
    const admin=(await post('/api/login',{slug:'acme',name:'Ravi',pin:'481902'})).body.token;
    await post('/api/admin/users',{name:'Neha',pin:'774411',team:'Sales'},admin);
    await post('/api/admin/users',{name:'Sam',pin:'905513',team:'Ops'},admin);
    const neha=(await post('/api/login',{slug:'acme',name:'Neha',pin:'774411'})).body.token;
    const nid=db.prepare("SELECT id FROM users WHERE name='Neha'").get().id;

    const a1=(await post('/api/my/plan',{title:'Sharma quotation',estimate_min:30},neha)).body.item.id;
    const a2=(await post('/api/my/plan',{title:'Follow up 3 leads',estimate_min:60},neha)).body.item.id;
    const asg=(await post('/api/admin/plans',{user_id:nid,title:'Prepare board deck',estimate_min:90},admin)).body.item.id;
    const old=(await post('/api/my/plan',{title:'Weekly report',estimate_min:45},neha)).body.item.id;
    const y=new Date(Date.now()+330*60000-86400000).toISOString().slice(0,10);
    db.prepare('UPDATE plan_items SET plan_date=? WHERE id=?').run(y,old);
    await call('/api/my/plan',{},neha); // trigger rollover

    const s1=(await post('/api/sessions/start',{task:'Sharma quotation',planned_minutes:30,plan_item_id:a1},neha)).body.session.id;
    db.prepare("UPDATE sessions SET status='completed',actual_seconds=1500,ended_at=? WHERE id=?").run(nowISO(),s1);
    await patch('/api/my/plan/'+a1,{status:'done'},neha);
    const s2=(await post('/api/sessions/start',{task:'Follow up 3 leads',planned_minutes:60,plan_item_id:a2},neha)).body.session.id;
    await post(`/api/sessions/${s2}/distraction`,{reason:'WhatsApp'},neha);
    db.prepare("UPDATE sessions SET status='completed',actual_seconds=3300,ended_at=? WHERE id=?").run(nowISO(),s2);
    const s3=(await post('/api/sessions/start',{task:'Emergency client call',planned_minutes:30},neha)).body.session.id;
    db.prepare("UPDATE sessions SET status='completed',actual_seconds=1200,ended_at=? WHERE id=?").run(nowISO(),s3);
    await patch('/api/my/plan/'+asg,{status:'skipped',skip_reason:'Waiting on figures from finance'},neha);

    const sam=(await post('/api/login',{slug:'acme',name:'Sam',pin:'905513'})).body.token;
    const s4=(await post('/api/sessions/start',{task:'Stock count',planned_minutes:45},sam)).body.session.id;
    db.prepare("UPDATE sessions SET status='completed',actual_seconds=2400,ended_at=? WHERE id=?").run(nowISO(),s4);

    const report=(await call('/api/admin/daily-report',{},admin)).body;

    // Pull the arrow function straight out of the workflow file and run it.
    const wf=JSON.parse(fs.readFileSync('./n8n-daily-report.json','utf8'));
    const tmpl=wf.nodes.find(n=>n.name==='Email the report').parameters.text;
    const expr=tmpl.match(/\{\{ (\(\(\) => \{[\s\S]*\}\)\(\)) \}\}/)[1];
    const out=new Function('$json','return '+expr)(report);

    console.log('\n----- rendered email -----\n'+out+'\n--------------------------\n');

    assert.ok(out.includes('Neha'),'the person who worked must appear');
    assert.ok(out.includes('[x] Sharma quotation'),'a finished task should be ticked');
    assert.ok(out.includes('[-] Prepare board deck'),'a skipped task should be dashed');
    assert.ok(out.includes('skipped: Waiting on figures from finance'));
    ok('the email shows each task with its outcome and any skip reason');

    assert.ok(/25m actual/.test(out),'estimate vs actual should be on the line');
    assert.ok(out.includes('you assigned'),'assigned work should be labelled');
    ok('estimate against actual, and who assigned it, appear per task');

    assert.ok(/moved 1x/.test(out),'a carried-forward task should say so');
    ok('a task carried over from yesterday is flagged in the email');

    assert.ok(/\+ 20m on 1 unplanned session/.test(out));
    ok('unplanned work is reported, not hidden');

    assert.ok(out.includes('NO ACTIVITY AT ALL'),'people who did nothing should be named');
    ok('people with no plan and no sessions are listed separately');

    assert.ok(/Of the work you assigned, 0 of 1 got done/.test(out));
    ok('the assigned-work headline is stated plainly');

    assert.ok(!/undefined|NaN|\[object/.test(out),'no template leakage');
    ok('no undefined, NaN or [object Object] anywhere in the output');

    assert.ok(Math.max(...out.split('\n').map(l=>l.length)) < 95,'lines must stay phone-readable');
    ok('every line is short enough to read on a phone');

    // a workspace where nobody did anything at all
    const inv2=(await post('/api/master/codes',{},master)).body.code;
    await post('/api/signup',{code:inv2,business_name:'Quiet Co',slug:'quietco',owner_name:'Priya',owner_pin:'620744',contact_email:'p@q.com'});
    const q=(await post('/api/login',{slug:'quietco',name:'Priya',pin:'620744'})).body.token;
    const qr=(await call('/api/admin/daily-report',{},q)).body;
    const qout=new Function('$json','return '+expr)(qr);
    assert.ok(!/undefined|NaN/.test(qout));
    assert.ok(qout.includes('0 of 1 people worked'));
    ok('a completely quiet workspace still renders a sensible email');

    console.log('\nEmail body checks passed.\n'); srv.close(); process.exit(0);
  }catch(e){console.error('\nFAILED:',e.message);console.error(e.stack.split('\n').slice(0,3).join('\n'));srv.close();process.exit(1)}
});
