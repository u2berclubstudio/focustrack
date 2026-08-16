process.env.MAIL_MODE='capture'; process.env.DATA_DIR='/tmp/ft-ui';
const assert=require('assert');
const {JSDOM}=require('jsdom');
const fs=require('fs');
const app=require('./server');
const {db,hashPin,nowISO}=require('./db');
const mailer=require('./mailer');

const srv=app.listen(0,async()=>{
  const port=srv.address().port, base=`http://127.0.0.1:${port}`;
  const call=async(p,o={},t)=>{const r=await fetch(base+p,{...o,headers:{'Content-Type':'application/json',...(t?{Authorization:'Bearer '+t}:{})}});
    let b;const x=await r.text();try{b=JSON.parse(x)}catch{b=x}return{status:r.status,body:b}};
  const post=(p,b,t)=>call(p,{method:'POST',body:JSON.stringify(b||{})},t);
  const ok=m=>console.log('  ✓ '+m);

  try{
    for(const t of ['plan_items','distractions','sessions','tokens','users','invite_codes','businesses','audit_log','login_guard','otp_challenges'])db.prepare(`DELETE FROM ${t}`).run();
    db.prepare(`INSERT INTO users (business_id,name,pin_hash,role,team,email,created_at) VALUES (NULL,?,?,'master','p',?,?)`).run('Atul',hashPin('481902'),'b@e.com',nowISO());
    const f=await post('/api/master/login',{name:'Atul',pin:'481902'});
    const c=mailer.sent.at(-1).text.match(/\b(\d{6})\b/)[1];
    const master=(await post('/api/master/otp',{challenge:f.body.challenge,code:c})).body.token;
    const inv=(await post('/api/master/codes',{seat_limit:20},master)).body.code;
    await post('/api/signup',{code:inv,business_name:'Acme',slug:'acme',owner_name:'Ravi',owner_pin:'481902'});
    const admin=(await post('/api/login',{slug:'acme',name:'Ravi',pin:'481902'})).body.token;
    await post('/api/admin/users',{name:'Neha',pin:'774411',team:'Sales'},admin);
    const neha=(await post('/api/login',{slug:'acme',name:'Neha',pin:'774411'})).body.token;
    const nehaId=db.prepare("SELECT id FROM users WHERE name='Neha'").get().id;

    // realistic plan data
    const a=(await post('/api/my/plan',{title:'Sharma quotation',estimate_min:30},neha)).body.item.id;
    await post('/api/my/plan',{title:'Client call',estimate_min:60,at_time:'15:00'},neha);
    await post('/api/admin/plans',{user_id:nehaId,title:'Prepare board deck',estimate_min:90},admin);
    const old=(await post('/api/my/plan',{title:'Weekly report',estimate_min:45},neha)).body.item.id;
    const y=new Date(Date.now()+330*60000-86400000).toISOString().slice(0,10);
    db.prepare('UPDATE plan_items SET plan_date=? WHERE id=?').run(y,old);
    const s=await post('/api/sessions/start',{task:'Sharma quotation',planned_minutes:30,plan_item_id:a},neha);
    db.prepare("UPDATE sessions SET status='completed',actual_seconds=1500,ended_at=? WHERE id=?").run(nowISO(),s.body.session.id);

    // ---- render app.html against the live API ----
    const html=fs.readFileSync('./public/app.html','utf8');
    const dom=new JSDOM(html,{runScripts:'outside-only',url:base+'/acme'});
    const w=dom.window;
    w.fetch=(u,o)=>fetch(base+u,o);
    w.matchMedia=()=>({matches:false,addEventListener(){},removeEventListener(){}});
    w.navigator.serviceWorker=undefined;
    w.localStorage.setItem('ft_token_acme',neha);
    // strip the boot IIFE + install prompt; we only want the plan renderer
    const script=[...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(m=>m[1]).join('\n')
      .replace(/^\(function \(\)[\s\S]*?\}\)\(\);/m,'');
    w.eval(script.replace(/boot\(\);?\s*$/,''));
    await w.loadPlan();
    const list=w.document.getElementById('planList').innerHTML;

    assert.ok(list.includes('Sharma quotation'),'own task should render');
    assert.ok(list.includes('Prepare board deck'),'assigned task should render');
    ok('the plan card renders both your own tasks and assigned ones');

    assert.ok(list.includes('from Ravi'),'assigned task must name who assigned it');
    ok('an assigned task is visibly tagged with who assigned it');

    assert.ok(list.includes('3pm'),'15:00 should read as 3pm');
    ok('a fixed time is shown the way people say it');

    assert.ok(/moved once/.test(list),'carried-forward task should say so');
    ok('a task carried over from yesterday says "moved once"');

    assert.ok(list.includes('25m logged'),'time logged against a task should show');
    ok('time already logged against a task appears on the row');

    const assignedRow=list.split('<div class="pi').find(x=>x.includes('Prepare board deck'));
    const ownRow=list.split('<div class="pi').find(x=>x.includes('Sharma quotation'));
    assert.ok(!/data-act="del"/.test(assignedRow),'assigned work must not offer a delete button');
    assert.ok(/data-act="del"/.test(ownRow),'your own task should offer delete');
    ok('the delete button appears only on your own tasks, not assigned ones');

    assert.ok(w.document.getElementById('planTotal').textContent.includes('left'));
    ok('the header shows how much is left to do');

    // escaping
    await post('/api/my/plan',{title:'<img src=x onerror=alert(1)>'},neha);
    await w.loadPlan();
    const esc=w.document.getElementById('planList').innerHTML;
    assert.ok(!esc.includes('<img src=x'),'html in a task title must be escaped');
    assert.ok(esc.includes('&lt;img'));
    ok('a task title containing HTML is escaped, not executed');

    // ---- render admin.html ----
    const ahtml=fs.readFileSync('./public/admin.html','utf8');
    const adom=new JSDOM(ahtml,{runScripts:'outside-only',url:base+'/acme/admin'});
    const aw=adom.window;
    aw.fetch=(u,o)=>fetch(base+u,o);
    aw.localStorage.setItem('ft_token_acme',admin);
    const ascript=[...ahtml.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(m=>m[1]).join('\n')
      .replace(/^\(function \(\)[\s\S]*?\}\)\(\);/m,'')
      .replace(/\(async \(\) => \{[\s\S]*?\}\)\(\);\s*$/,'');
    aw.eval(ascript);
    await aw.loadPlans();
    const pp=aw.document.getElementById('planPeople').innerHTML;
    assert.ok(pp.includes('Neha')&&pp.includes('Ravi'),'every member should get a card');
    assert.ok(pp.includes('Prepare board deck'));
    assert.ok(pp.includes('you assigned'));
    ok('the admin Plans tab lists each person with their tasks');
    assert.ok(pp.includes('data-add='),'today should allow assigning');
    ok('an assign box is offered for today');

    // overload badge
    for(let i=0;i<6;i++) await post('/api/admin/plans',{user_id:nehaId,title:'Task '+i,estimate_min:60},admin);
    await aw.loadPlans();
    const pp2=aw.document.getElementById('planPeople').innerHTML;
    assert.ok(pp2.includes('over a full day'),'an overloaded day should be badged');
    ok('a day stacked past what fits is badged on the admin screen');

    // planned vs actual on the overview
    await aw.load();
    const people=aw.document.getElementById('people').innerHTML;
    assert.ok(/Planned <b>/.test(people),'cards should compare planned with logged');
    ok('the overview card compares planned time against logged time');

    // someone who planned but never used the timer
    await post('/api/admin/users',{name:'Ghost',pin:'318266'},admin);
    const gid=db.prepare("SELECT id FROM users WHERE name='Ghost'").get().id;
    await post('/api/admin/plans',{user_id:gid,title:'Never started',estimate_min:120},admin);
    await aw.load();
    const p3=aw.document.getElementById('people').innerHTML;
    assert.ok(p3.includes('Ghost'),'someone who planned but never started must still appear');
    assert.ok(p3.includes('No timer use'));
    assert.ok(!/Ghost[\s\S]{0,400}width:3%/.test(p3),'they should get no score bar at all');
    ok('someone who planned but never started shows as "No timer use", not a zero score');


    // The Settings preview and the automation email must say the same thing;
    // if they drift, an admin tunes the report against a lie.
    await aw.loadSettings();
    const rep=(await call('/api/admin/daily-report',{},admin)).body;
    const shown=aw.renderReport(rep);
    const wf=JSON.parse(require('fs').readFileSync('./n8n-daily-report.json','utf8'));
    const expr=wf.nodes.find(n=>n.name==='Email the report').parameters.text
      .match(/\{\{ (\(\(\) => \{[\s\S]*\}\)\(\)) \}\}/)[1];
    const emailed=new Function('$json','return '+expr)(rep);
    const norm=x=>x.split('\n').map(l=>l.trimEnd()).filter(l=>l&&!/^(THE DAY IN ONE LINE|Dashboard:|To change|FocusTrack —)/.test(l)).join('\n');
    assert.strictEqual(norm(shown), norm(emailed), 'preview and email must match');
    ok('the Settings preview renders exactly what the automation emails');

    assert.strictEqual(aw.document.getElementById('reportHour').value,'18');
    ok('the report hour loads into the Settings form');

    console.log('\nUI checks passed.\n'); srv.close(); process.exit(0);
  }catch(e){console.error('\nFAILED:',e.message);console.error(e.stack.split('\n').slice(0,4).join('\n'));srv.close();process.exit(1)}
});
