const JSON_HEADERS = {"content-type":"application/json; charset=UTF-8","cache-control":"no-store"};
const COOKIE_NAME = "jfu_admin_session";

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    try {
      if (url.pathname.startsWith("/api/")) {
        await ensureSchema(env);
      }

      if (url.pathname === "/api/orders" && request.method === "POST") {
        return await createOrder(request, env);
      }

      if (url.pathname === "/admin" || url.pathname === "/admin/") {
        return new Response(adminPage(), {
          headers: {"content-type":"text/html; charset=UTF-8","cache-control":"no-store"}
        });
      }

      if (url.pathname === "/api/admin/login" && request.method === "POST") {
        return await adminLogin(request, env);
      }

      if (url.pathname === "/api/admin/logout" && request.method === "POST") {
        return new Response(JSON.stringify({ok:true}), {
          headers: {...JSON_HEADERS, "set-cookie": `${COOKIE_NAME}=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0`}
        });
      }

      if (url.pathname === "/api/admin/orders" && request.method === "GET") {
        if (!await isAdmin(request, env)) return json({error:"æªç»å¥"}, 401);
        return await listOrders(url, env);
      }

      const statusMatch = url.pathname.match(/^\/api\/admin\/orders\/(\d+)\/status$/);
      if (statusMatch && request.method === "POST") {
        if (!await isAdmin(request, env)) return json({error:"æªç»å¥"}, 401);
        return await updateStatus(request, env, Number(statusMatch[1]));
      }

      const paymentMatch = url.pathname.match(/^\/api\/admin\/orders\/(\d+)\/payment$/);
      if (paymentMatch && request.method === "POST") {
        if (!await isAdmin(request, env)) return json({error:"æªç»å¥"}, 401);
        return await updatePaymentStatus(request, env, Number(paymentMatch[1]));
      }

      const deleteMatch = url.pathname.match(/^\/api\/admin\/orders\/(\d+)$/);
      if (deleteMatch && request.method === "DELETE") {
        if (!await isAdmin(request, env)) return json({error:"æªç»å¥"}, 401);
        await env.DB.prepare("DELETE FROM orders WHERE id=?").bind(Number(deleteMatch[1])).run();
        return json({ok:true});
      }

      return env.ASSETS.fetch(request);
    } catch (e) {
      console.error(e);
      if (url.pathname.startsWith("/api/")) return json({error:"ç³»çµ±æ«æç¼çé¯èª¤ï¼è«ç¨å¾åè©¦ã"}, 500);
      return new Response("Server error", {status:500});
    }
  }
};

async function ensureSchema(env) {
  if (!env.DB) throw new Error("å°æªç¶å® D1 è³æåº«ï¼è«å¨ Cloudflare è¨­å® DB bindingã");

  // ä»¥ç®åå¯¦éä½¿ç¨çæ¬ä½çºä¸»å»ºç«å®æ´è³æè¡¨
  await env.DB.prepare(`
    CREATE TABLE IF NOT EXISTS orders (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      order_no TEXT NOT NULL UNIQUE,
      created_at TEXT NOT NULL,
      customer_name TEXT NOT NULL,
      phone TEXT NOT NULL,
      ship_date TEXT NOT NULL,
      shipping_method TEXT NOT NULL,
      shipping_info TEXT NOT NULL,
      note TEXT,
      boxes TEXT NOT NULL,
      product_total INTEGER NOT NULL,
      shipping_fee INTEGER NOT NULL,
      total INTEGER NOT NULL,
      payment_status TEXT NOT NULL DEFAULT 'æªç¢ºèª',
      order_status TEXT NOT NULL DEFAULT 'æ°è¨å®'
    )
  `).run();

  // èç D1 è¥å·²å­å¨ orders è¡¨ï¼è£ä¸æ°çéè¦çæ¬ä½ã
  const cols = await env.DB.prepare(`PRAGMA table_info(orders)`).all();
  const names = new Set((cols.results || []).map(r => r.name));
  const addColumn = async (name, ddl) => {
    if (!names.has(name)) {
      await env.DB.prepare(`ALTER TABLE orders ADD COLUMN ${ddl}`).run();
      names.add(name);
    }
  };

  await addColumn('ship_date', "ship_date TEXT NOT NULL DEFAULT ''");
  await addColumn('shipping_info', "shipping_info TEXT NOT NULL DEFAULT ''");
  await addColumn('boxes', "boxes TEXT NOT NULL DEFAULT '[]'");
  await addColumn('product_total', "product_total INTEGER NOT NULL DEFAULT 0");
  await addColumn('payment_status', "payment_status TEXT NOT NULL DEFAULT 'æªç¢ºèª'");
  await addColumn('order_status', "order_status TEXT NOT NULL DEFAULT 'æ°è¨å®'");

  // èæ¬ä½è³ææ¬å°æ°æ¬ä½ï¼é¿åæ¢æè¨å®æ¶å¤±ã
  if (names.has('address')) {
    await env.DB.prepare(`UPDATE orders SET shipping_info = CASE WHEN shipping_info='' THEN COALESCE(address,'') ELSE shipping_info END`).run();
  }
  if (names.has('boxes_json')) {
    await env.DB.prepare(`UPDATE orders SET boxes = CASE WHEN boxes='[]' OR boxes='' THEN COALESCE(boxes_json,'[]') ELSE boxes END`).run();
  }
  if (names.has('subtotal')) {
    await env.DB.prepare(`UPDATE orders SET product_total = CASE WHEN product_total=0 THEN COALESCE(subtotal,0) ELSE product_total END`).run();
  }
  if (names.has('status')) {
    await env.DB.prepare(`UPDATE orders SET order_status = CASE WHEN order_status='æ°è¨å®' AND status IS NOT NULL AND status<>'' THEN status ELSE order_status END`).run();
  }

  await env.DB.prepare(`CREATE INDEX IF NOT EXISTS idx_orders_created_at ON orders(created_at)`).run();
  await env.DB.prepare(`CREATE INDEX IF NOT EXISTS idx_orders_ship_date ON orders(ship_date)`).run();
}

function json(data, status=200, extraHeaders={}) {
  return new Response(JSON.stringify(data), {status, headers:{...JSON_HEADERS,...extraHeaders}});
}

function cleanText(v, max=300) {
  return String(v ?? "").trim().slice(0, max);
}

async function createOrder(request, env) {
  const body = await request.json().catch(()=>null);
  if (!body) return json({error:"è¨å®è³ææ ¼å¼é¯èª¤ã"}, 400);

  const customer_name = cleanText(body.customer_name, 80);
  const phone = cleanText(body.phone, 30);
  const ship_date = cleanText(body.ship_date, 30);
  const shipping_method = cleanText(body.shipping_method, 40);
  const address = cleanText(body.address, 300);
  const note = cleanText(body.note, 500);
  const allowedDates = ["9/15ï¼äºï¼","9/21ï¼ä¸ï¼"];
  const allowedShipping = {"å®é":120,"7-11 è¶ååè²¨":60,"å¨å®¶è¶ååè²¨":60};

  if (!customer_name || !phone || !address) return json({error:"å§åãé»è©±èæ¶ä»¶è³è¨ççºå¿å¡«ã"}, 400);
  if (!allowedDates.includes(ship_date)) return json({error:"è«é¸æææçåºè²¨æ¥æã"}, 400);
  if (!(shipping_method in allowedShipping)) return json({error:"ééæ¹å¼ä¸æ­£ç¢ºã"}, 400);
  if (!Array.isArray(body.boxes) || body.boxes.length < 1 || body.boxes.length > 30) return json({error:"ç¦®çè³æä¸æ­£ç¢ºã"}, 400);

  const prices = {
    "èé»é¥":55,"èè¦æµå¿":55,"ç¸ææµå¿":55,"åéæµå¿":55,
    "èé ­é¥":50,"å°çé¥":50,"æ¹è¶é¥":50,"å°æé¤":50,
    "å°æå¨":50,"å°ç¶ è±æ¤ª":50,"éµè§é³è¶é¥":50
  };
  const allowedSizes = [6,9,12,15];

  let computedSubtotal = 0;
  const safeBoxes = [];
  for (let bi=0; bi<body.boxes.length; bi++) {
    const b = body.boxes[bi];
    const size = Number(b.size);
    if (!allowedSizes.includes(size) || !Array.isArray(b.selections)) return json({error:`ç¬¬ ${bi+1} çè³æä¸æ­£ç¢ºã`},400);

    let count=0, boxPrice=0;
    const selections=[];
    for (const s of b.selections) {
      const name=cleanText(s.name,50), qty=Number(s.qty);
      if (!(name in prices) || !Number.isInteger(qty) || qty<1 || qty>size) return json({error:`ç¬¬ ${bi+1} çå£å³è³æä¸æ­£ç¢ºã`},400);
      count += qty;
      boxPrice += prices[name]*qty;
      selections.push({name,qty,unit_price:prices[name]});
    }
    if (count !== size) return json({error:`ç¬¬ ${bi+1} çå¿é åå¥½é¸æ»¿ ${size} é¡ã`},400);
    computedSubtotal += boxPrice;
    safeBoxes.push({box_no:bi+1,size,box_price:boxPrice,selections});
  }

  const shippingFee = allowedShipping[shipping_method];
  const total = computedSubtotal + shippingFee;
  const now = new Date().toISOString();
  const rand = crypto.randomUUID().replace(/-/g,"").slice(0,4).toUpperCase();
  const twDate = new Intl.DateTimeFormat("zh-TW",{timeZone:"Asia/Taipei",year:"2-digit",month:"2-digit",day:"2-digit"}).format(new Date()).replace(/\D/g,"");
  const order_no = `JFU${twDate}-${rand}`;

  await env.DB.prepare(`
    INSERT INTO orders (
      order_no,
      created_at,
      customer_name,
      phone,
      ship_date,
      shipping_method,
      shipping_info,
      note,
      boxes,
      product_total,
      shipping_fee,
      total,
      payment_status,
      order_status
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).bind(
    order_no,
    now,
    customer_name,
    phone,
    ship_date,
    shipping_method,
    address,
    note,
    JSON.stringify(safeBoxes),
    computedSubtotal,
    shippingFee,
    total,
    "æªç¢ºèª",
    "æ°è¨å®"
  ).run();

  return json({ok:true,order_no,total,status:"å¾å¯æ¬¾"},201);
}

async function digestHex(text) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map(b=>b.toString(16).padStart(2,"0")).join("");
}

async function expectedSession(env) {
  if (!env.ADMIN_PASSWORD || String(env.ADMIN_PASSWORD).length < 8) return null;
  return digestHex(`JFU-BAKERY-ADMIN|${env.ADMIN_PASSWORD}`);
}

function getCookie(request, name) {
  const cookie=request.headers.get("cookie")||"";
  for (const part of cookie.split(";")) {
    const [k,...rest]=part.trim().split("=");
    if (k===name) return rest.join("=");
  }
  return "";
}

async function isAdmin(request, env) {
  const expected=await expectedSession(env);
  return !!expected && getCookie(request,COOKIE_NAME)===expected;
}

async function adminLogin(request, env) {
  if (!env.ADMIN_PASSWORD || String(env.ADMIN_PASSWORD).length < 8) {
    return json({error:"å¾å°å¯ç¢¼å°æªè¨­å®ãè«åå¨ Cloudflare è¨­å® ADMIN_PASSWORDã"},500);
  }
  const body=await request.json().catch(()=>({}));
  if (String(body.password||"") !== String(env.ADMIN_PASSWORD)) return json({error:"å¯ç¢¼é¯èª¤"},401);
  const token=await expectedSession(env);
  return json({ok:true},200,{
    "set-cookie":`${COOKIE_NAME}=${token}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=28800`
  });
}

async function listOrders(url, env) {
  const shipDate=cleanText(url.searchParams.get("ship_date")||"",30);
  const status=cleanText(url.searchParams.get("status")||"",30);
  const q=cleanText(url.searchParams.get("q")||"",80);

  let where=[], binds=[];
  if (shipDate) { where.push("ship_date=?"); binds.push(shipDate); }
  if (status) { where.push("order_status=?"); binds.push(status); }
  if (q) {
    where.push("(customer_name LIKE ? OR phone LIKE ? OR order_no LIKE ?)");
    const like=`%${q}%`; binds.push(like,like,like);
  }
  const sql=`SELECT * FROM orders ${where.length?"WHERE "+where.join(" AND "):""} ORDER BY id DESC LIMIT 500`;
  const res=await env.DB.prepare(sql).bind(...binds).all();
  return json({orders:res.results||[]});
}

async function updateStatus(request, env, id) {
  const body=await request.json().catch(()=>({}));
  const status=cleanText(body.status,30);
  const allowed=["æ°è¨å®","è£½ä½ä¸­","å·²åºè²¨","å·²å®æ","å·²åæ¶"];
  if (!allowed.includes(status)) return json({error:"çæä¸æ­£ç¢º"},400);
  await env.DB.prepare("UPDATE orders SET order_status=? WHERE id=?").bind(status,id).run();
  return json({ok:true});
}

async function updatePaymentStatus(request, env, id) {
  const body=await request.json().catch(()=>({}));
  const payment_status=cleanText(body.payment_status,30);
  const allowed=["æªç¢ºèª","å·²ä»æ¬¾"];
  if (!allowed.includes(payment_status)) return json({error:"ä»æ¬¾çæä¸æ­£ç¢º"},400);
  await env.DB.prepare("UPDATE orders SET payment_status=? WHERE id=?").bind(payment_status,id).run();
  return json({ok:true});
}

function adminPage() {
  return `<!doctype html><html lang="zh-Hant"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>æ¡å¯å±ççåï½è¨å®å¾å°</title>
<style>
:root{--bg:#f7f2e9;--card:#fff;--ink:#362d27;--muted:#796f68;--accent:#9a6647;--line:#e8ddd1}
*{box-sizing:border-box}body{margin:0;font-family:-apple-system,BlinkMacSystemFont,"PingFang TC","Noto Sans TC",sans-serif;background:var(--bg);color:var(--ink)}
.wrap{max-width:1100px;margin:auto;padding:18px}.top{display:flex;justify-content:space-between;align-items:center;gap:10px;margin-bottom:14px}h1{font-size:23px;margin:0}
.card{background:#fff;border:1px solid var(--line);border-radius:16px;padding:15px;margin-bottom:12px}input,select,button{font:inherit;border:1px solid var(--line);border-radius:10px;padding:10px;background:#fff}button{cursor:pointer;font-weight:700}
.primary{background:var(--accent);color:#fff;border-color:var(--accent)}.filters{display:grid;grid-template-columns:1.3fr 1fr 1fr auto;gap:8px}.stats{display:grid;grid-template-columns:repeat(4,1fr);gap:8px}.stat{background:#fff;border:1px solid var(--line);border-radius:14px;padding:12px}.stat b{display:block;font-size:21px}
.order{border-top:1px solid var(--line);padding:14px 0}.order:first-child{border-top:0}.ohead{display:flex;justify-content:space-between;gap:8px;align-items:flex-start}.no{font-weight:900}.muted{color:var(--muted);font-size:13px}.badge{display:inline-block;padding:4px 8px;border-radius:999px;background:#efe5dc;font-size:12px;font-weight:800}
.detailgrid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:10px;margin:14px 0}.detailgrid>div,.infoBlock,.boxcard,.pricebox{background:#fffaf7;border:1px solid var(--line);border-radius:12px;padding:12px}.detailgrid span,.label{display:block;color:var(--muted);font-size:12px;margin-bottom:4px}.boxesArea{display:grid;gap:10px;margin:12px 0}.boxtitle{font-weight:900;margin-bottom:8px}.itemrow{display:flex;justify-content:space-between;padding:5px 0;border-bottom:1px dashed var(--line)}.itemrow:last-child{border-bottom:0}.pricebox{margin:12px 0}.pricebox>div{display:flex;justify-content:space-between;padding:5px 0}.pricebox .grand{margin-top:5px;padding-top:10px;border-top:1px solid var(--line);font-size:18px}.actions{display:flex;gap:10px;align-items:end;flex-wrap:wrap;margin-top:14px}.actions label{flex:1;min-width:160px}.danger{background:#fff;border:1px solid #b85d50;color:#9a3d32}.empty{text-align:center;padding:35px;color:var(--muted)}#login{max-width:430px;margin:70px auto}
@media(max-width:700px){.filters{grid-template-columns:1fr 1fr}.stats{grid-template-columns:1fr 1fr}.detailgrid{grid-template-columns:1fr}.ohead{display:block}}
</style></head><body><div class="wrap">
<div id="login" class="card"><h1>æ¡å¯å±ççåï½è¨å®å¾å°</h1><p class="muted">è«è¼¸å¥åºå®¶ç®¡çå¯ç¢¼</p><input id="pw" type="password" placeholder="ç®¡çå¯ç¢¼" style="width:100%;margin-bottom:10px"><button class="primary" style="width:100%" onclick="login()">ç»å¥</button><p id="loginerr" class="danger"></p></div>
<div id="app" hidden><div class="top"><div><h1>è¨å®ç®¡ç</h1><div class="muted">æ¡å¯å±ççå JFU BAKERY</div></div><button onclick="logout()">ç»åº</button></div>
<div id="stats" class="stats"></div><div class="card filters"><input id="q" placeholder="æå°å§åï¼é»è©±ï¼è¨å®ç·¨è"><select id="date"><option value="">å¨é¨åºè²¨æ¥</option><option>9/15ï¼äºï¼</option><option>9/21ï¼ä¸ï¼</option></select><select id="status"><option value="">å¨é¨çæ</option><option>æ°è¨å®</option><option>è£½ä½ä¸­</option><option>å·²åºè²¨</option><option>å·²å®æ</option><option>å·²åæ¶</option></select><button class="primary" onclick="load()">æå°</button></div><div id="orders" class="card"></div></div></div>
<script>
const $=id=>document.getElementById(id);
async function api(path,opt={}){const r=await fetch(path,opt);const d=await r.json().catch(()=>({}));if(r.status===401){$("app").hidden=true;$("login").hidden=false;throw new Error("è«éæ°ç»å¥")}if(!r.ok)throw new Error(d.error||"æä½å¤±æ");return d}
async function login(){try{await api("/api/admin/login",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({password:$("pw").value})});$("login").hidden=true;$("app").hidden=false;load()}catch(e){$("loginerr").textContent=e.message}}
async function logout(){await fetch("/api/admin/logout",{method:"POST"});location.reload()}
function esc(s){return String(s??"").replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]))}
function fmt(t){try{return new Intl.DateTimeFormat("zh-TW",{timeZone:"Asia/Taipei",year:"numeric",month:"2-digit",day:"2-digit",hour:"2-digit",minute:"2-digit"}).format(new Date(t))}catch{return t}}
async function load(){let p=new URLSearchParams();if($("q").value)p.set("q",$("q").value);if($("date").value)p.set("ship_date",$("date").value);if($("status").value)p.set("status",$("status").value);try{let d=await api("/api/admin/orders?"+p);render(d.orders)}catch(e){$("orders").innerHTML='<div class="empty">'+esc(e.message)+'</div>'}}
function render(a){
 const total=a.length;
 const money=a.filter(o=>(o.order_status||o.status)!=="å·²åæ¶").reduce((s,o)=>s+Number(o.total||0),0);
 const unpaid=a.filter(o=>(o.payment_status||"æªç¢ºèª")!=="å·²ä»æ¬¾"&&(o.order_status||o.status)!=="å·²åæ¶").length;
 const paid=a.filter(o=>(o.payment_status||"æªç¢ºèª")==="å·²ä»æ¬¾").length;
 $("stats").innerHTML='<div class="stat"><span class="muted">è¨å®</span><b>'+total+'</b></div><div class="stat"><span class="muted">ç¸½éé¡</span><b>$'+money+'</b></div><div class="stat"><span class="muted">æªç¢ºèªä»æ¬¾</span><b>'+unpaid+'</b></div><div class="stat"><span class="muted">å·²ä»æ¬¾</span><b>'+paid+'</b></div>';
 if(!a.length){$("orders").innerHTML='<div class="empty">ç®åæ²æç¬¦åæ¢ä»¶çè¨å®</div>';return}
 $("orders").innerHTML=a.map(o=>{
   let boxesHtml='';
   try{const boxes=JSON.parse(o.boxes||o.boxes_json||'[]');boxesHtml=boxes.map(b=>'<div class="boxcard"><div class="boxtitle">ç¬¬ '+esc(b.box_no||'-')+' çï½'+esc(b.size||'-')+' å¥</div>'+(b.selections||[]).map(s=>'<div class="itemrow"><span>'+esc(s.name)+'</span><b>Ã '+esc(s.qty)+'</b></div>').join('')+'</div>').join('')}catch(e){boxesHtml='<div class="muted">ç¦®çå§å®¹ç¡æ³è§£æ</div>'}
   const rawNote=o.note||'';const noteLines=rawNote.split('\\n');const legacyShip=(noteLines.find(x=>x.startsWith('åºè²¨æ¥æï¼'))||'').replace('åºè²¨æ¥æï¼','');const shipDate=o.ship_date||legacyShip||'æªè¨­å®';const cleanNote=noteLines.filter(x=>!x.startsWith('åºè²¨æ¥æï¼')).join('\\n').trim()||'ç¡';
   const orderStatus=o.order_status||o.status||'æ°è¨å®';const paymentStatus=o.payment_status||'æªç¢ºèª';const shippingInfo=o.shipping_info||o.address||'';
   return '<div class="order"><div class="ohead"><div><div class="no">'+esc(o.order_no||'')+'</div><div class="muted">è¨å®æ¥æï¼'+esc(fmt(o.created_at||''))+'</div></div><span class="badge">'+esc(orderStatus)+'</span></div>'+ 
   '<div class="detailgrid"><div><span>è¨è³¼äºº</span><b>'+esc(o.customer_name||'')+'</b></div><div><span>é»è©±</span><b>'+esc(o.phone||'')+'</b></div><div><span>åºè²¨æ¥æ</span><b>'+esc(shipDate)+'</b></div><div><span>ééæ¹å¼</span><b>'+esc(o.shipping_method||'')+'</b></div></div>'+ 
   '<div class="infoBlock"><span class="label">æ¶ä»¶å°åï¼éå¸</span><div>'+esc(shippingInfo)+'</div></div><div class="boxesArea">'+boxesHtml+'</div>'+ 
   '<div class="pricebox"><div><span>ååå°è¨</span><b>$'+Number(o.product_total||o.subtotal||0)+'</b></div><div><span>éè²»</span><b>$'+Number(o.shipping_fee||0)+'</b></div><div class="grand"><span>ç¸½è¨</span><b>$'+Number(o.total||0)+'</b></div></div>'+ 
   '<div class="infoBlock"><span class="label">åè¨»</span><div>'+esc(cleanNote)+'</div></div>'+ 
   '<div class="actions"><label>è¨å®çæ<select id="s'+o.id+'" onchange="statusChange('+o.id+')"><option '+(orderStatus==='æ°è¨å®'?'selected':'')+'>æ°è¨å®</option><option '+(orderStatus==='è£½ä½ä¸­'?'selected':'')+'>è£½ä½ä¸­</option><option '+(orderStatus==='å·²åºè²¨'?'selected':'')+'>å·²åºè²¨</option><option '+(orderStatus==='å·²å®æ'?'selected':'')+'>å·²å®æ</option><option '+(orderStatus==='å·²åæ¶'?'selected':'')+'>å·²åæ¶</option></select></label>'+ 
   '<label>ä»æ¬¾çæ<select id="p'+o.id+'" onchange="paymentChange('+o.id+')"><option '+(paymentStatus==='æªç¢ºèª'?'selected':'')+'>æªç¢ºèª</option><option '+(paymentStatus==='å·²ä»æ¬¾'?'selected':'')+'>å·²ä»æ¬¾</option></select></label>'+ 
   '<button class="danger" onclick="delOrder('+o.id+')">åªé¤è¨å®</button></div></div>';
 }).join('')
}
async function statusChange(id){try{await api('/api/admin/orders/'+id+'/status',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({status:$("s"+id).value})});load()}catch(e){alert(e.message)}}
async function paymentChange(id){try{await api('/api/admin/orders/'+id+'/payment',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({payment_status:$("p"+id).value})});load()}catch(e){alert(e.message)}}
async function delOrder(id){if(!confirm('ç¢ºå®è¦åªé¤éç­è¨å®åï¼æ­¤æä½ç¡æ³å¾©åã'))return;try{await api('/api/admin/orders/'+id,{method:'DELETE'});load()}catch(e){alert(e.message)}}
api('/api/admin/orders').then(()=>{$("login").hidden=true;$("app").hidden=false;load()}).catch(()=>{});
</script></body></html>`;
}
