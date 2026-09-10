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
        if (!await isAdmin(request, env)) return json({error:"\u672A\u767B\u5165"}, 401);
        return await listOrders(url, env);
      }

      const statusMatch = url.pathname.match(/^\/api\/admin\/orders\/(\d+)\/status$/);
      if (statusMatch && request.method === "POST") {
        if (!await isAdmin(request, env)) return json({error:"\u672A\u767B\u5165"}, 401);
        return await updateStatus(request, env, Number(statusMatch[1]));
      }

      const paymentMatch = url.pathname.match(/^\/api\/admin\/orders\/(\d+)\/payment$/);
      if (paymentMatch && request.method === "POST") {
        if (!await isAdmin(request, env)) return json({error:"\u672A\u767B\u5165"}, 401);
        return await updatePaymentStatus(request, env, Number(paymentMatch[1]));
      }

      const deleteMatch = url.pathname.match(/^\/api\/admin\/orders\/(\d+)$/);
      if (deleteMatch && request.method === "DELETE") {
        if (!await isAdmin(request, env)) return json({error:"\u672A\u767B\u5165"}, 401);
        await env.DB.prepare("DELETE FROM orders WHERE id=?").bind(Number(deleteMatch[1])).run();
        return json({ok:true});
      }

      return env.ASSETS.fetch(request);
    } catch (e) {
      console.error(e);
      if (url.pathname.startsWith("/api/")) return json({error:"\u7CFB\u7D71\u66AB\u6642\u767C\u751F\u932F\u8AA4\uFF0C\u8ACB\u7A0D\u5F8C\u518D\u8A66\u3002"}, 500);
      return new Response("Server error", {status:500});
    }
  }
};

async function ensureSchema(env) {
  if (!env.DB) throw new Error("\u5C1A\u672A\u7D81\u5B9A D1 \u8CC7\u6599\u5EAB\uFF0C\u8ACB\u5728 Cloudflare \u8A2D\u5B9A DB binding\u3002");

  // \u4EE5\u76EE\u524D\u5BE6\u969B\u4F7F\u7528\u7684\u6B04\u4F4D\u70BA\u4E3B\u5EFA\u7ACB\u5B8C\u6574\u8CC7\u6599\u8868
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
      payment_status TEXT NOT NULL DEFAULT '\u672A\u78BA\u8A8D',
      order_status TEXT NOT NULL DEFAULT '\u65B0\u8A02\u55AE'
    )
  `).run();

  // \u820A\u7248 D1 \u82E5\u5DF2\u5B58\u5728 orders \u8868\uFF0C\u88DC\u4E0A\u65B0\u7248\u9700\u8981\u7684\u6B04\u4F4D\u3002
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
  await addColumn('payment_status', "payment_status TEXT NOT NULL DEFAULT '\u672A\u78BA\u8A8D'");
  await addColumn('order_status', "order_status TEXT NOT NULL DEFAULT '\u65B0\u8A02\u55AE'");

  // \u820A\u6B04\u4F4D\u8CC7\u6599\u642C\u5230\u65B0\u6B04\u4F4D\uFF0C\u907F\u514D\u65E2\u6709\u8A02\u55AE\u6D88\u5931\u3002
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
    await env.DB.prepare(`UPDATE orders SET order_status = CASE WHEN order_status='\u65B0\u8A02\u55AE' AND status IS NOT NULL AND status<>'' THEN status ELSE order_status END`).run();
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
  if (!body) return json({error:"\u8A02\u55AE\u8CC7\u6599\u683C\u5F0F\u932F\u8AA4\u3002"}, 400);

  const customer_name = cleanText(body.customer_name, 80);
  const phone = cleanText(body.phone, 30);
  const ship_date = cleanText(body.ship_date, 30);
  const shipping_method = cleanText(body.shipping_method, 40);
  const address = cleanText(body.address, 300);
  const note = cleanText(body.note, 500);
  const allowedDates = ["9/15\uFF08\u4E8C\uFF09","9/21\uFF08\u4E00\uFF09"];
  const allowedShipping = {"\u5B85\u914D":120,"7-11 \u8D85\u5546\u53D6\u8CA8":60,"\u5168\u5BB6\u8D85\u5546\u53D6\u8CA8":60};

  if (!customer_name || !phone || !address) return json({error:"\u59D3\u540D\u3001\u96FB\u8A71\u8207\u6536\u4EF6\u8CC7\u8A0A\u7686\u70BA\u5FC5\u586B\u3002"}, 400);
  if (!allowedDates.includes(ship_date)) return json({error:"\u8ACB\u9078\u64C7\u6709\u6548\u7684\u51FA\u8CA8\u65E5\u671F\u3002"}, 400);
  if (!(shipping_method in allowedShipping)) return json({error:"\u914D\u9001\u65B9\u5F0F\u4E0D\u6B63\u78BA\u3002"}, 400);
  if (!Array.isArray(body.boxes) || body.boxes.length < 1 || body.boxes.length > 30) return json({error:"\u79AE\u76D2\u8CC7\u6599\u4E0D\u6B63\u78BA\u3002"}, 400);

  const prices = {
    "\u86CB\u9EC3\u9165":55,"\u828B\u898B\u6D41\u5FC3":55,"\u76F8\u601D\u6D41\u5FC3":55,"\u5207\u9054\u6D41\u5FC3":55,
    "\u828B\u982D\u9165":50,"\u5730\u74DC\u9165":50,"\u62B9\u8336\u9165":50,"\u5C0F\u6708\u9905":50,
    "\u5C0F\u6708\u5A18":50,"\u5C0F\u7DA0\u8C46\u692A":50,"\u9435\u89C0\u97F3\u8336\u9165":50
  };
  const allowedSizes = [6,9,12,15];

  let computedSubtotal = 0;
  const safeBoxes = [];
  for (let bi=0; bi<body.boxes.length; bi++) {
    const b = body.boxes[bi];
    const size = Number(b.size);
    if (!allowedSizes.includes(size) || !Array.isArray(b.selections)) return json({error:`\u7B2C ${bi+1} \u76D2\u8CC7\u6599\u4E0D\u6B63\u78BA\u3002`},400);

    let count=0, boxPrice=0;
    const selections=[];
    for (const s of b.selections) {
      const name=cleanText(s.name,50), qty=Number(s.qty);
      if (!(name in prices) || !Number.isInteger(qty) || qty<1 || qty>size) return json({error:`\u7B2C ${bi+1} \u76D2\u53E3\u5473\u8CC7\u6599\u4E0D\u6B63\u78BA\u3002`},400);
      count += qty;
      boxPrice += prices[name]*qty;
      selections.push({name,qty,unit_price:prices[name]});
    }
    if (count !== size) return json({error:`\u7B2C ${bi+1} \u76D2\u5FC5\u9808\u525B\u597D\u9078\u6EFF ${size} \u9846\u3002`},400);
    computedSubtotal += boxPrice;
    safeBoxes.push({box_no:bi+1,size,box_price:boxPrice,selections});
  }

  const shippingFee = allowedShipping[shipping_method];
  const total = computedSubtotal + shippingFee;
  const now = new Date().toISOString();
  const rand = crypto.randomUUID().replace(/-/g,"").slice(0,4).toUpperCase();
  const twDate = new Intl.DateTimeFormat("zh-TW",{timeZone:"Asia/Taipei",year:"2-digit",month:"2-digit",day:"2-digit"}).format(new Date()).replace(/\D/g,"");
  const order_no = `JFU${twDate}-${rand}`;

  // \u540C\u6642\u76F8\u5BB9\u820A\u7248\u8207\u65B0\u7248 D1 \u6B04\u4F4D\uFF0C\u907F\u514D\u820A\u8868\u7684 NOT NULL \u6B04\u4F4D\u963B\u64CB\u65B0\u589E\u8A02\u55AE\u3002
  const colRes = await env.DB.prepare(`PRAGMA table_info(orders)`).all();
  const colNames = new Set((colRes.results || []).map(r => r.name));
  const boxJson = JSON.stringify(safeBoxes);

  const insertData = {
    order_no, created_at: now, customer_name, phone, ship_date, shipping_method,
    shipping_info: address, note, boxes: boxJson, product_total: computedSubtotal,
    shipping_fee: shippingFee, total, payment_status: "\u672A\u78BA\u8A8D", order_status: "\u65B0\u8A02\u55AE",
    // \u820A\u7248\u6B04\u4F4D\u4E5F\u4E00\u8D77\u586B\uFF0C\u8B93\u65E2\u6709\u820A\u8CC7\u6599\u8868\u53EF\u4EE5\u7E7C\u7E8C\u4F7F\u7528\u3002
    address, boxes_json: boxJson, subtotal: computedSubtotal, status: "\u65B0\u8A02\u55AE"
  };

  const insertCols = Object.keys(insertData).filter(k => colNames.has(k));
  const placeholders = insertCols.map(() => "?").join(",");
  const values = insertCols.map(k => insertData[k]);
  await env.DB.prepare(
    `INSERT INTO orders (${insertCols.join(",")}) VALUES (${placeholders})`
  ).bind(...values).run();

  return json({ok:true,order_no,total,status:"\u5F85\u532F\u6B3E"},201);
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
    return json({error:"\u5F8C\u53F0\u5BC6\u78BC\u5C1A\u672A\u8A2D\u5B9A\u3002\u8ACB\u5148\u5728 Cloudflare \u8A2D\u5B9A ADMIN_PASSWORD\u3002"},500);
  }
  const body=await request.json().catch(()=>({}));
  if (String(body.password||"") !== String(env.ADMIN_PASSWORD)) return json({error:"\u5BC6\u78BC\u932F\u8AA4"},401);
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
  const allowed=["\u65B0\u8A02\u55AE","\u88FD\u4F5C\u4E2D","\u5DF2\u51FA\u8CA8","\u5DF2\u5B8C\u6210","\u5DF2\u53D6\u6D88"];
  if (!allowed.includes(status)) return json({error:"\u72C0\u614B\u4E0D\u6B63\u78BA"},400);
  const cols=await env.DB.prepare(`PRAGMA table_info(orders)`).all();
  const names=new Set((cols.results||[]).map(r=>r.name));
  if(names.has("status")) {
    await env.DB.prepare("UPDATE orders SET order_status=?, status=? WHERE id=?").bind(status,status,id).run();
  } else {
    await env.DB.prepare("UPDATE orders SET order_status=? WHERE id=?").bind(status,id).run();
  }
  return json({ok:true});
}

async function updatePaymentStatus(request, env, id) {
  const body=await request.json().catch(()=>({}));
  const payment_status=cleanText(body.payment_status,30);
  const allowed=["\u672A\u78BA\u8A8D","\u5DF2\u4ED8\u6B3E"];
  if (!allowed.includes(payment_status)) return json({error:"\u4ED8\u6B3E\u72C0\u614B\u4E0D\u6B63\u78BA"},400);
  await env.DB.prepare("UPDATE orders SET payment_status=? WHERE id=?").bind(payment_status,id).run();
  return json({ok:true});
}

function adminPage() {
  return `<!doctype html><html lang="zh-Hant"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>\u6854\u5BCC\u5C4B\u70D8\u7119\u574A\uFF5C\u8A02\u55AE\u5F8C\u53F0</title>
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
<div id="login" class="card"><h1>\u6854\u5BCC\u5C4B\u70D8\u7119\u574A\uFF5C\u8A02\u55AE\u5F8C\u53F0</h1><p class="muted">\u8ACB\u8F38\u5165\u5E97\u5BB6\u7BA1\u7406\u5BC6\u78BC</p><input id="pw" type="password" placeholder="\u7BA1\u7406\u5BC6\u78BC" style="width:100%;margin-bottom:10px"><button class="primary" style="width:100%" onclick="login()">\u767B\u5165</button><p id="loginerr" class="danger"></p></div>
<div id="app" hidden><div class="top"><div><h1>\u8A02\u55AE\u7BA1\u7406</h1><div class="muted">\u6854\u5BCC\u5C4B\u70D8\u7119\u574A JFU BAKERY</div></div><button onclick="logout()">\u767B\u51FA</button></div>
<div id="stats" class="stats"></div><div class="card filters"><input id="q" placeholder="\u641C\u5C0B\u59D3\u540D\uFF0F\u96FB\u8A71\uFF0F\u8A02\u55AE\u7DE8\u865F"><select id="date"><option value="">\u5168\u90E8\u51FA\u8CA8\u65E5</option><option>9/15\uFF08\u4E8C\uFF09</option><option>9/21\uFF08\u4E00\uFF09</option></select><select id="status"><option value="">\u5168\u90E8\u72C0\u614B</option><option>\u65B0\u8A02\u55AE</option><option>\u88FD\u4F5C\u4E2D</option><option>\u5DF2\u51FA\u8CA8</option><option>\u5DF2\u5B8C\u6210</option><option>\u5DF2\u53D6\u6D88</option></select><button class="primary" onclick="load()">\u641C\u5C0B</button></div><div id="orders" class="card"></div></div></div>
<script>
const $=id=>document.getElementById(id);
async function api(path,opt={}){const r=await fetch(path,opt);const d=await r.json().catch(()=>({}));if(r.status===401){$("app").hidden=true;$("login").hidden=false;throw new Error("\u8ACB\u91CD\u65B0\u767B\u5165")}if(!r.ok)throw new Error(d.error||"\u64CD\u4F5C\u5931\u6557");return d}
async function login(){try{await api("/api/admin/login",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({password:$("pw").value})});$("login").hidden=true;$("app").hidden=false;load()}catch(e){$("loginerr").textContent=e.message}}
async function logout(){await fetch("/api/admin/logout",{method:"POST"});location.reload()}
function esc(s){return String(s??"").replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]))}
function fmt(t){try{return new Intl.DateTimeFormat("zh-TW",{timeZone:"Asia/Taipei",year:"numeric",month:"2-digit",day:"2-digit",hour:"2-digit",minute:"2-digit"}).format(new Date(t))}catch{return t}}
async function load(){let p=new URLSearchParams();if($("q").value)p.set("q",$("q").value);if($("date").value)p.set("ship_date",$("date").value);if($("status").value)p.set("status",$("status").value);try{let d=await api("/api/admin/orders?"+p);render(d.orders)}catch(e){$("orders").innerHTML='<div class="empty">'+esc(e.message)+'</div>'}}
function render(a){
 const total=a.length;
 const money=a.filter(o=>(o.order_status||o.status)!=="\u5DF2\u53D6\u6D88").reduce((s,o)=>s+Number(o.total||0),0);
 const unpaid=a.filter(o=>(o.payment_status||"\u672A\u78BA\u8A8D")!=="\u5DF2\u4ED8\u6B3E"&&(o.order_status||o.status)!=="\u5DF2\u53D6\u6D88").length;
 const paid=a.filter(o=>(o.payment_status||"\u672A\u78BA\u8A8D")==="\u5DF2\u4ED8\u6B3E").length;
 $("stats").innerHTML='<div class="stat"><span class="muted">\u8A02\u55AE</span><b>'+total+'</b></div><div class="stat"><span class="muted">\u7E3D\u91D1\u984D</span><b>$'+money+'</b></div><div class="stat"><span class="muted">\u672A\u78BA\u8A8D\u4ED8\u6B3E</span><b>'+unpaid+'</b></div><div class="stat"><span class="muted">\u5DF2\u4ED8\u6B3E</span><b>'+paid+'</b></div>';
 if(!a.length){$("orders").innerHTML='<div class="empty">\u76EE\u524D\u6C92\u6709\u7B26\u5408\u689D\u4EF6\u7684\u8A02\u55AE</div>';return}
 $("orders").innerHTML=a.map(o=>{
   let boxesHtml='';
   try{const boxes=JSON.parse(o.boxes||o.boxes_json||'[]');boxesHtml=boxes.map(b=>'<div class="boxcard"><div class="boxtitle">\u7B2C '+esc(b.box_no||'-')+' \u76D2\uFF5C'+esc(b.size||'-')+' \u5165</div>'+(b.selections||[]).map(s=>'<div class="itemrow"><span>'+esc(s.name)+'</span><b>\u00D7 '+esc(s.qty)+'</b></div>').join('')+'</div>').join('')}catch(e){boxesHtml='<div class="muted">\u79AE\u76D2\u5167\u5BB9\u7121\u6CD5\u89E3\u6790</div>'}
   const rawNote=o.note||'';const noteLines=rawNote.split('\\n');const legacyShip=(noteLines.find(x=>x.startsWith('\u51FA\u8CA8\u65E5\u671F\uFF1A'))||'').replace('\u51FA\u8CA8\u65E5\u671F\uFF1A','');const shipDate=o.ship_date||legacyShip||'\u672A\u8A2D\u5B9A';const cleanNote=noteLines.filter(x=>!x.startsWith('\u51FA\u8CA8\u65E5\u671F\uFF1A')).join('\\n').trim()||'\u7121';
   const orderStatus=o.order_status||o.status||'\u65B0\u8A02\u55AE';const paymentStatus=o.payment_status||'\u672A\u78BA\u8A8D';const shippingInfo=o.shipping_info||o.address||'';
   return '<div class="order"><div class="ohead"><div><div class="no">'+esc(o.order_no||'')+'</div><div class="muted">\u8A02\u55AE\u65E5\u671F\uFF1A'+esc(fmt(o.created_at||''))+'</div></div><span class="badge">'+esc(orderStatus)+'</span></div>'+ 
   '<div class="detailgrid"><div><span>\u8A02\u8CFC\u4EBA</span><b>'+esc(o.customer_name||'')+'</b></div><div><span>\u96FB\u8A71</span><b>'+esc(o.phone||'')+'</b></div><div><span>\u51FA\u8CA8\u65E5\u671F</span><b>'+esc(shipDate)+'</b></div><div><span>\u914D\u9001\u65B9\u5F0F</span><b>'+esc(o.shipping_method||'')+'</b></div></div>'+ 
   '<div class="infoBlock"><span class="label">\u6536\u4EF6\u5730\u5740\uFF0F\u9580\u5E02</span><div>'+esc(shippingInfo)+'</div></div><div class="boxesArea">'+boxesHtml+'</div>'+ 
   '<div class="pricebox"><div><span>\u5546\u54C1\u5C0F\u8A08</span><b>$'+Number(o.product_total||o.subtotal||0)+'</b></div><div><span>\u904B\u8CBB</span><b>$'+Number(o.shipping_fee||0)+'</b></div><div class="grand"><span>\u7E3D\u8A08</span><b>$'+Number(o.total||0)+'</b></div></div>'+ 
   '<div class="infoBlock"><span class="label">\u5099\u8A3B</span><div>'+esc(cleanNote)+'</div></div>'+ 
   '<div class="actions"><label>\u8A02\u55AE\u72C0\u614B<select id="s'+o.id+'" onchange="statusChange('+o.id+')"><option '+(orderStatus==='\u65B0\u8A02\u55AE'?'selected':'')+'>\u65B0\u8A02\u55AE</option><option '+(orderStatus==='\u88FD\u4F5C\u4E2D'?'selected':'')+'>\u88FD\u4F5C\u4E2D</option><option '+(orderStatus==='\u5DF2\u51FA\u8CA8'?'selected':'')+'>\u5DF2\u51FA\u8CA8</option><option '+(orderStatus==='\u5DF2\u5B8C\u6210'?'selected':'')+'>\u5DF2\u5B8C\u6210</option><option '+(orderStatus==='\u5DF2\u53D6\u6D88'?'selected':'')+'>\u5DF2\u53D6\u6D88</option></select></label>'+ 
   '<label>\u4ED8\u6B3E\u72C0\u614B<select id="p'+o.id+'" onchange="paymentChange('+o.id+')"><option '+(paymentStatus==='\u672A\u78BA\u8A8D'?'selected':'')+'>\u672A\u78BA\u8A8D</option><option '+(paymentStatus==='\u5DF2\u4ED8\u6B3E'?'selected':'')+'>\u5DF2\u4ED8\u6B3E</option></select></label>'+ 
   '<button class="danger" onclick="delOrder('+o.id+')">\u522A\u9664\u8A02\u55AE</button></div></div>';
 }).join('')
}
async function statusChange(id){try{await api('/api/admin/orders/'+id+'/status',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({status:$("s"+id).value})});load()}catch(e){alert(e.message)}}
async function paymentChange(id){try{await api('/api/admin/orders/'+id+'/payment',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({payment_status:$("p"+id).value})});load()}catch(e){alert(e.message)}}
async function delOrder(id){if(!confirm('\u78BA\u5B9A\u8981\u522A\u9664\u9019\u7B46\u8A02\u55AE\u55CE\uFF1F\u6B64\u64CD\u4F5C\u7121\u6CD5\u5FA9\u539F\u3002'))return;try{await api('/api/admin/orders/'+id,{method:'DELETE'});load()}catch(e){alert(e.message)}}
api('/api/admin/orders').then(()=>{$("login").hidden=true;$("app").hidden=false;load()}).catch(()=>{});
</script></body></html>`;
}
