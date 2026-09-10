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
        if (!await isAdmin(request, env)) return json({error:"未登入"}, 401);
        return await listOrders(url, env);
      }

      const statusMatch = url.pathname.match(/^\/api\/admin\/orders\/(\d+)\/status$/);
      if (statusMatch && request.method === "POST") {
        if (!await isAdmin(request, env)) return json({error:"未登入"}, 401);
        return await updateStatus(request, env, Number(statusMatch[1]));
      }

      const deleteMatch = url.pathname.match(/^\/api\/admin\/orders\/(\d+)$/);
      if (deleteMatch && request.method === "DELETE") {
        if (!await isAdmin(request, env)) return json({error:"未登入"}, 401);
        await env.DB.prepare("DELETE FROM orders WHERE id=?").bind(Number(deleteMatch[1])).run();
        return json({ok:true});
      }

      return env.ASSETS.fetch(request);
    } catch (e) {
      console.error(e);
      if (url.pathname.startsWith("/api/")) return json({error:"系統暫時發生錯誤，請稍後再試。"}, 500);
      return new Response("Server error", {status:500});
    }
  }
};

async function ensureSchema(env) {
  if (!env.DB) throw new Error("尚未綁定 D1 資料庫，請在 Cloudflare 設定 DB binding。");
  await env.DB.prepare(`
    CREATE TABLE IF NOT EXISTS orders (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      order_no TEXT NOT NULL UNIQUE,
      created_at TEXT NOT NULL,
      customer_name TEXT NOT NULL,
      phone TEXT NOT NULL,
      ship_date TEXT NOT NULL,
      shipping_method TEXT NOT NULL,
      address TEXT NOT NULL,
      note TEXT,
      boxes_json TEXT NOT NULL,
      subtotal INTEGER NOT NULL,
      shipping_fee INTEGER NOT NULL,
      total INTEGER NOT NULL,
      status TEXT NOT NULL DEFAULT '待匯款'
    )
  `).run();
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
  if (!body) return json({error:"訂單資料格式錯誤。"}, 400);

  const customer_name = cleanText(body.customer_name, 80);
  const phone = cleanText(body.phone, 30);
  const ship_date = cleanText(body.ship_date, 30);
  const shipping_method = cleanText(body.shipping_method, 40);
  const address = cleanText(body.address, 300);
  const note = cleanText(body.note, 500);
  const allowedDates = ["9/15（二）","9/21（一）"];
  const allowedShipping = {"宅配":120,"7-11 超商取貨":60,"全家超商取貨":60};

  if (!customer_name || !phone || !address) return json({error:"姓名、電話與收件資訊皆為必填。"}, 400);
  if (!allowedDates.includes(ship_date)) return json({error:"請選擇有效的出貨日期。"}, 400);
  if (!(shipping_method in allowedShipping)) return json({error:"配送方式不正確。"}, 400);
  if (!Array.isArray(body.boxes) || body.boxes.length < 1 || body.boxes.length > 30) return json({error:"禮盒資料不正確。"}, 400);

  const prices = {
    "蛋黃酥":55,"芋見流心":55,"相思流心":55,"切達流心":55,
    "芋頭酥":50,"地瓜酥":50,"抹茶酥":50,"小月餅":50,
    "小月娘":50,"小綠豆椪":50,"鐵觀音茶酥":50
  };
  const allowedSizes = [6,9,12,15];

  let computedSubtotal = 0;
  const safeBoxes = [];
  for (let bi=0; bi<body.boxes.length; bi++) {
    const b = body.boxes[bi];
    const size = Number(b.size);
    if (!allowedSizes.includes(size) || !Array.isArray(b.selections)) return json({error:`第 ${bi+1} 盒資料不正確。`},400);

    let count=0, boxPrice=0;
    const selections=[];
    for (const s of b.selections) {
      const name=cleanText(s.name,50), qty=Number(s.qty);
      if (!(name in prices) || !Number.isInteger(qty) || qty<1 || qty>size) return json({error:`第 ${bi+1} 盒口味資料不正確。`},400);
      count += qty;
      boxPrice += prices[name]*qty;
      selections.push({name,qty,unit_price:prices[name]});
    }
    if (count !== size) return json({error:`第 ${bi+1} 盒必須剛好選滿 ${size} 顆。`},400);
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
  INSERT INTO orders
  (
    order_no,
    customer_name,
    phone,
    shipping_method,
    shipping_info,
    boxes,
    product_total,
    shipping_fee,
    total,
    note,
    payment_status,
    order_status
  )
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`).bind(
  order_no,
  customer_name,
  phone,
  shipping_method,
  address,
  JSON.stringify(safeBoxes),
  computedSubtotal,
  shippingFee,
  total,
  `出貨日期：${ship_date}${note ? "\n" + note : ""}`,
  "未確認",
  "新訂單"
).run();

  return json({ok:true,order_no,total,status:"待匯款"},201);
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
    return json({error:"後台密碼尚未設定。請先在 Cloudflare 設定 ADMIN_PASSWORD。"},500);
  }
  const body=await request.json().catch(()=>({}));
  if (String(body.password||"") !== String(env.ADMIN_PASSWORD)) return json({error:"密碼錯誤"},401);
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
  if (status) { where.push("status=?"); binds.push(status); }
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
  const allowed=["待匯款","已付款","製作中","已出貨","已完成","已取消"];
  if (!allowed.includes(status)) return json({error:"狀態不正確"},400);
  const result=await env.DB.prepare("UPDATE orders SET status=? WHERE id=?").bind(status,id).run();
  return json({ok:true});
}

function adminPage() {
return `<!doctype html><html lang="zh-Hant"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>桔富屋烘焙坊｜訂單後台</title>
<style>
:root{--bg:#f7f2e9;--card:#fff;--ink:#362d27;--muted:#796f68;--accent:#9a6647;--line:#e8ddd1}
*{box-sizing:border-box}body{margin:0;font-family:-apple-system,BlinkMacSystemFont,"PingFang TC","Noto Sans TC",sans-serif;background:var(--bg);color:var(--ink)}
.wrap{max-width:1100px;margin:auto;padding:18px}.top{display:flex;justify-content:space-between;align-items:center;gap:10px;margin-bottom:14px}
h1{font-size:23px;margin:0}.card{background:#fff;border:1px solid var(--line);border-radius:16px;padding:15px;margin-bottom:12px}
input,select,button{font:inherit;border:1px solid var(--line);border-radius:10px;padding:10px;background:#fff}button{cursor:pointer;font-weight:700}
.primary{background:var(--accent);color:#fff;border-color:var(--accent)}.filters{display:grid;grid-template-columns:1.3fr 1fr 1fr auto;gap:8px}
.stats{display:grid;grid-template-columns:repeat(4,1fr);gap:8px}.stat{background:#fff;border:1px solid var(--line);border-radius:14px;padding:12px}.stat b{display:block;font-size:21px}
.order{border-top:1px solid var(--line);padding:14px 0}.order:first-child{border-top:0}.head{display:flex;justify-content:space-between;gap:8px;align-items:flex-start}.no{font-weight:900}.muted{color:var(--muted);font-size:13px}
.grid{display:grid;grid-template-columns:1fr 1fr;gap:7px 16px;margin:10px 0}.boxes{background:#faf7f2;border-radius:12px;padding:10px;white-space:pre-wrap;font-size:14px;line-height:1.5}.actions{display:flex;gap:7px;align-items:center;margin-top:9px}
.badge{display:inline-block;padding:4px 8px;border-radius:999px;background:#efe5dc;font-size:12px;font-weight:800}
#login{max-width:430px;margin:70px auto}.danger{color:#a33}.empty{text-align:center;padding:35px;color:var(--muted)}
@media(max-width:700px){.filters{grid-template-columns:1fr 1fr}.stats{grid-template-columns:1fr 1fr}.grid{grid-template-columns:1fr}.head{display:block}.actions{flex-wrap:wrap}} .detailgrid{
  display:grid;
  grid-template-columns:repeat(2,minmax(0,1fr));
  gap:10px;
  margin:14px 0;
}
.detailgrid>div,.infoBlock,.boxcard,.pricebox{
  background:#fffaf7;
  border:1px solid var(--line);
  border-radius:12px;
  padding:12px;
}
.detailgrid span,.label{
  display:block;
  color:var(--muted);
  font-size:12px;
  margin-bottom:4px;
}
.boxesArea{
  display:grid;
  gap:10px;
  margin:12px 0;
}
.boxtitle{
  font-weight:900;
  margin-bottom:8px;
}
.itemrow{
  display:flex;
  justify-content:space-between;
  padding:5px 0;
  border-bottom:1px dashed var(--line);
}
.itemrow:last-child{
  border-bottom:0;
}
.pricebox{
  margin:12px 0;
}
.pricebox>div{
  display:flex;
  justify-content:space-between;
  padding:5px 0;
}
.pricebox .grand{
  margin-top:5px;
  padding-top:10px;
  border-top:1px solid var(--line);
  font-size:18px;
}
.actions{
  display:flex;
  gap:10px;
  align-items:end;
  flex-wrap:wrap;
  margin-top:14px;
}
.actions label{
  flex:1;
  min-width:160px;
}
.paystatus{
  padding:10px 12px;
  background:#fffaf7;
  border-radius:10px;
}
.danger{
  background:#fff;
  border:1px solid #b85d50;
  color:#9a3d32;
}
@media(max-width:700px){
  .detailgrid{
    grid-template-columns:1fr;
  }
}
     </style></head><body>
<div class="wrap">
<div id="login" class="card"><h1>桔富屋烘焙坊｜訂單後台</h1><p class="muted">請輸入店家管理密碼</p><input id="pw" type="password" placeholder="管理密碼" style="width:100%;margin-bottom:10px"><button class="primary" style="width:100%" onclick="login()">登入</button><p id="loginerr" class="danger"></p></div>
<div id="app" hidden>
<div class="top"><div><h1>訂單管理</h1><div class="muted">桔富屋烘焙坊 JFU BAKERY</div></div><button onclick="logout()">登出</button></div>
<div id="stats" class="stats"></div>
<div class="card filters">
<input id="q" placeholder="搜尋姓名／電話／訂單編號">
<select id="date"><option value="">全部出貨日</option><option>9/15（二）</option><option>9/21（一）</option></select>
<select id="status"><option value="">全部狀態</option><option>待匯款</option><option>已付款</option><option>製作中</option><option>已出貨</option><option>已完成</option><option>已取消</option></select>
<button class="primary" onclick="load()">搜尋</button>
</div>
<div id="orders" class="card"></div>
</div></div>
<script>
const $=id=>document.getElementById(id);
async function api(path,opt={}){const r=await fetch(path,opt);const d=await r.json().catch(()=>({}));if(r.status===401){$("app").hidden=true;$("login").hidden=false;throw new Error("請重新登入")}if(!r.ok)throw new Error(d.error||"操作失敗");return d}
async function login(){try{await api("/api/admin/login",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({password:$("pw").value})});$("login").hidden=true;$("app").hidden=false;load()}catch(e){$("loginerr").textContent=e.message}}
async function logout(){await fetch("/api/admin/logout",{method:"POST"});location.reload()}
function esc(s){return String(s??"").replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]))}
function fmt(t){try{return new Intl.DateTimeFormat("zh-TW",{timeZone:"Asia/Taipei",year:"numeric",month:"2-digit",day:"2-digit",hour:"2-digit",minute:"2-digit"}).format(new Date(t))}catch{return t}}
function boxText(j){try{return JSON.parse(j).map(b=>"第 "+b.box_no+" 盒｜"+b.size+" 入\\n"+b.selections.map(s=>s.name+" × "+s.qty).join("、")).join("\\n\\n")}catch{return ""}}
async function load(){
 let p=new URLSearchParams();if($("q").value)p.set("q",$("q").value);if($("date").value)p.set("ship_date",$("date").value);if($("status").value)p.set("status",$("status").value);
 try{let d=await api("/api/admin/orders?"+p);render(d.orders)}catch(e){$("orders").innerHTML='<div class="empty">'+esc(e.message)+'</div>'}
}
function render(a){
  const total=a.length;
  const money=a
    .filter(o=>(o.order_status||o.status)!=="已取消")
    .reduce((s,o)=>s+Number(o.total||0),0);

  const unpaid=a.filter(o=>
    (o.payment_status||"未確認")!=="已付款" &&
    (o.order_status||o.status)!=="已取消"
  ).length;

  const paid=a.filter(o=>
    (o.payment_status||"未確認")==="已付款"
  ).length;

  $("stats").innerHTML=
    '<div class="stat"><span class="muted">訂單</span><b>'+total+'</b></div>'+
    '<div class="stat"><span class="muted">總金額</span><b>$'+money+'</b></div>'+
    '<div class="stat"><span class="muted">未確認付款</span><b>'+unpaid+'</b></div>'+
    '<div class="stat"><span class="muted">已付款</span><b>'+paid+'</b></div>';

  if(!a.length){
    $("orders").innerHTML='<div class="empty">目前沒有符合條件的訂單</div>';
    return;
  }

  $("orders").innerHTML=a.map(o=>{
    let boxesHtml="";

    try{
      const boxes=JSON.parse(o.boxes||o.boxes_json||"[]");

      boxesHtml=boxes.map(b=>{
        const selections=(b.selections||[])
          .map(s=>'<div class="itemrow"><span>'+esc(s.name)+'</span><b>× '+s.qty+'</b></div>')
          .join("");

        return `
          <div class="boxcard">
            <div class="boxtitle">
              第 ${b.box_no||"-"} 盒｜${b.size||"-"} 入
            </div>
            ${selections}
          </div>
        `;
      }).join("");
    }catch(e){
      boxesHtml='<div class="muted">禮盒內容無法解析</div>';
    }

    const rawNote=o.note||"";
    const noteLines=rawNote.split("\\n");
    const shipDateLine=noteLines.find(x=>x.startsWith("出貨日期："))||"";
    const shipDate=shipDateLine.replace("出貨日期：","")||o.ship_date||"未設定";

    const cleanNote=noteLines
      .filter(x=>!x.startsWith("出貨日期："))
      .join("\\n")
      .trim() || "無";

    const orderStatus=o.order_status||o.status||"新訂單";
    const paymentStatus=o.payment_status||"未確認";
    const shippingInfo=o.shipping_info||o.address||"";

    return `
      <div class="order">
        <div class="ohead">
          <div>
            <div class="no">${esc(o.order_no||"")}</div>
            <div class="muted">訂單日期：${esc(o.created_at||"")}</div>
          </div>
          <span class="badge">${esc(orderStatus)}</span>
        </div>

        <div class="detailgrid">
          <div><span>訂購人</span><b>${esc(o.customer_name||"")}</b></div>
          <div><span>電話</span><b>${esc(o.phone||"")}</b></div>
          <div><span>出貨日期</span><b>${esc(shipDate)}</b></div>
          <div><span>配送方式</span><b>${esc(o.shipping_method||"")}</b></div>
        </div>

        <div class="infoBlock">
          <span class="label">收件地址／門市</span>
          <div>${esc(shippingInfo)}</div>
        </div>

        <div class="boxesArea">
          ${boxesHtml}
        </div>

        <div class="pricebox">
          <div><span>商品小計</span><b>$${Number(o.product_total||o.subtotal||0)}</b></div>
          <div><span>運費</span><b>$${Number(o.shipping_fee||0)}</b></div>
          <div class="grand"><span>總計</span><b>$${Number(o.total||0)}</b></div>
        </div>

        <div class="infoBlock">
          <span class="label">備註</span>
          <div>${esc(cleanNote)}</div>
        </div>

        <div class="actions">
          <label>
            訂單狀態
            <select id="s${o.id}" onchange="statusChange(${o.id})">
              <option ${orderStatus==="新訂單"?"selected":""}>新訂單</option>
              <option ${orderStatus==="製作中"?"selected":""}>製作中</option>
              <option ${orderStatus==="已出貨"?"selected":""}>已出貨</option>
              <option ${orderStatus==="已完成"?"selected":""}>已完成</option>
              <option ${orderStatus==="已取消"?"selected":""}>已取消</option>
            </select>
          </label>

          <div class="paystatus">
            付款狀態：<b>${esc(paymentStatus)}</b>
          </div>

          <button class="danger" onclick="delOrder(${o.id},'${esc(o.order_no||"")}')">
            刪除訂單
          </button>
        </div>
      </div>
    `;
  }).join("");
}async function statusChange(id){try{await api("/api/admin/orders/"+id+"/status",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({status:$("s"+id).value})});load()}catch(e){alert(e.message)}}
async function delOrder(id,no){if(!confirm("確定刪除 "+no+"？刪除後無法復原。"))return;try{await api("/api/admin/orders/"+id,{method:"DELETE"});load()}catch(e){alert(e.message)}}
$("q").addEventListener("keydown",e=>{if(e.key==="Enter")load()});
fetch("/api/admin/orders").then(r=>{if(r.ok){$("login").hidden=true;$("app").hidden=false;return r.json()}throw 0}).then(d=>d&&render(d.orders)).catch(()=>{});
</script></body></html>`;
}
