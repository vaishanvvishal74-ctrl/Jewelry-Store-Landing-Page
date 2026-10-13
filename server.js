
<!DOCTYPE html>
<html lang="hi">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="theme-color" content="#8e44ad">
<title>Jewellery Store Admin</title>
<style>
:root{
  --primary:#8e44ad;
  --secondary:#d63384;
  --bg:#f7f3fa;
  --card:#fff;
  --text:#292235;
  --muted:#756b7c;
  --border:#eadff0;
  --green:#168653;
  --red:#c0392b;
}
*{box-sizing:border-box}
body{
  margin:0;background:var(--bg);color:var(--text);
  font-family:system-ui,-apple-system,sans-serif
}
button,input,select{font:inherit}
button{border:0;border-radius:9px;padding:11px 14px;
background:var(--primary);color:white;font-weight:700;cursor:pointer}
button:disabled{opacity:.6;cursor:wait}
input,select{
  width:100%;padding:11px;border:1px solid var(--border);
  border-radius:9px;background:white;color:var(--text)
}
label{display:block;font-weight:700;font-size:13px;margin:12px 0 6px}
.hidden{display:none!important}
.muted{font-size:13px;color:var(--muted)}
header{
  background:linear-gradient(120deg,#8e44ad,#d63384);
  color:white;padding:16px;position:sticky;top:0;z-index:5
}
.header-inner{
  max-width:1200px;margin:auto;display:flex;
  align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap
}
header .muted{color:#f5eafa}
main{max-width:1200px;margin:auto;padding:18px 12px 40px}
.panel,.stat,.login-card{
  background:var(--card);border:1px solid var(--border);
  border-radius:15px;padding:16px;margin-bottom:16px
}
.login-wrap{min-height:100vh;display:grid;place-items:center;padding:16px}
.login-card{width:100%;max-width:420px;padding:25px}
.login-card h1{color:var(--primary)}
.full{width:100%;margin-top:16px}
.secondary{background:#f0e5f7;color:#6e3289}
.danger{background:#ffeded;color:var(--red)}
.success{background:#e4f7ec;color:var(--green)}
.actions{display:flex;gap:7px;flex-wrap:wrap}
.actions button{font-size:12px;padding:9px}
.stats{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:12px}
.stat strong{display:block;font-size:25px;margin-top:8px;color:var(--primary)}
.tabs{display:flex;gap:8px;flex-wrap:wrap;margin-bottom:16px}
.tab{background:white;color:var(--text);border:1px solid var(--border)}
.tab.active{background:var(--primary);color:white}
.toolbar{display:flex;gap:10px;flex-wrap:wrap;margin:12px 0}
.toolbar>*{flex:1;min-width:140px}
.table-wrap{overflow-x:auto;border:1px solid var(--border);border-radius:10px}
table{width:100%;border-collapse:collapse;min-width:650px}
th,td{text-align:left;padding:11px;border-bottom:1px solid var(--border);font-size:13px;vertical-align:top}
th{background:#f8effb}
.badge{display:inline-block;padding:5px 8px;border-radius:20px;background:#f0e5f7;font-size:11px;font-weight:700}
.notice{padding:12px;border-radius:9px;margin:10px 0;overflow-wrap:anywhere;background:#f0e5f7}
.notice.error{background:#ffeded;color:#a32626}
.notice.success{background:#e4f7ec;color:#17663b}
.detail{border:1px solid var(--border);border-radius:10px;padding:13px;margin:12px 0;overflow-wrap:anywhere}
.grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:0 12px}
.span2{grid-column:1/-1}
.product-img{width:44px;height:44px;object-fit:cover;border-radius:7px;vertical-align:middle;margin-right:8px}
footer{text-align:center;padding:20px;color:var(--muted);font-size:12px}
@media(max-width:650px){
 .stats{grid-template-columns:1fr}
 .grid{grid-template-columns:1fr}
 .span2{grid-column:auto}
 .panel{padding:12px}
}
</style>
</head>
<body>

<section id="loginView" class="login-wrap">
  <form id="loginForm" class="login-card">
    <h1>💎 Store Admin</h1>
    <p class="muted">अपने Jewellery Store को सुरक्षित तरीके से मैनेज करें।</p>
    <label for="password">Admin Password</label>
    <input id="password" type="password" required autocomplete="current-password">
    <button id="loginBtn" class="full" type="submit">Login</button>
    <div id="loginMessage" aria-live="polite"></div>
  </form>
</section>

<div id="adminView" class="hidden">
<header>
  <div class="header-inner">
    <div><strong>💎 JEWELLERY ADMIN</strong><div class="muted">Products · Orders · Payments</div></div>
    <div class="actions">
      <button id="refreshBtn" class="secondary">Refresh</button>
      <button id="logoutBtn" class="danger">Logout</button>
    </div>
  </div>
</header>

<main>
  <div id="globalMessage" aria-live="polite"></div>

  <div class="stats">
    <div class="stat">Total Products<strong id="productCount">0</strong></div>
    <div class="stat">Total Orders<strong id="orderCount">0</strong></div>
    <div class="stat">Pending Orders<strong id="pendingCount">0</strong></div>
  </div>

  <nav class="tabs">
    <button class="tab active" data-tab="orders">📦 Orders</button>
    <button class="tab" data-tab="products">💍 Products</button>
  </nav>

  <section id="ordersSection">
    <div class="panel">
      <h2>Customer Orders</h2>
      <div class="toolbar">
        <input id="orderSearch" placeholder="Order ID, customer या phone खोजें">
        <select id="orderFilter">
          <option value="">सभी Status</option>
          <option value="pending">Pending</option>
          <option value="confirmed">Confirmed</option>
          <option value="processing">Processing</option>
          <option value="shipped">Shipped</option>
          <option value="delivered">Delivered</option>
          <option value="cancelled">Cancelled</option>
          <option value="rejected">Rejected</option>
        </select>
      </div>
      <div class="table-wrap">
        <table>
          <thead><tr><th>Order</th><th>Customer</th><th>Total</th><th>Status</th><th>Date</th><th>Action</th></tr></thead>
          <tbody id="ordersBody"><tr><td colspan="6">Login के बाद Orders दिखेंगे।</td></tr></tbody>
        </table>
      </div>
    </div>

    <div id="orderPanel" class="panel hidden">
      <div class="header-inner">
        <h2 id="orderTitle">Order Details</h2>
        <button class="secondary" id="closeOrder">Close</button>
      </div>
      <div id="orderDetails"></div>
    </div>
  </section>

  <section id="productsSection" class="hidden">
    <div class="panel">
      <div class="header-inner">
        <h2>Manage Products</h2>
        <button id="addProductBtn">+ Add Product</button>
      </div>

      <div id="productFormWrap" class="detail hidden">
        <h3 id="productFormTitle">Add Product</h3>
        <form id="productForm">
          <label for="productName">Product Name</label>
          <input id="productName" maxlength="200" required>

          <div class="grid">
            <div>
              <label for="productPrice">Price (₹)</label>
              <input id="productPrice" type="number" min="0" max="100000000" step="0.01" required>
            </div>
            <div>
              <label for="productImage">HTTPS Image URL</label>
              <input id="productImage" type="url" placeholder="https://..." required>
            </div>
          </div>
          <div class="actions" style="margin-top:14px">
            <button id="saveProductBtn">Save Product</button>
            <button type="button" id="cancelProductBtn" class="secondary">Cancel</button>
          </div>
          <div id="productMessage"></div>
        </form>
      </div>

      <input id="productSearch" placeholder="Product खोजें" style="margin:12px 0">
      <div class="table-wrap">
        <table>
          <thead><tr><th>Product</th><th>Price</th><th>ID</th><th>Actions</th></tr></thead>
          <tbody id="productsBody"><tr><td colspan="4">Products लोड हो रहे हैं...</td></tr></tbody>
        </table>
      </div>
    </div>
  </section>
</main>
<footer>Jewellery Store Admin Panel</footer>
</div>

<script>
"use strict";

const API="/api";
const TOKEN_KEY="jewelleryAdminToken";
const STATUSES=["pending","confirmed","processing","shipped","delivered","cancelled","rejected"];

let products=[];
let orders=[];
let editingProductId=null;
let selectedOrderId=null;

const $=id=>document.getElementById(id);
const token=()=>localStorage.getItem(TOKEN_KEY)||"";

function esc(value){
  return String(value??"").replace(/[&<>"']/g,c=>({
    "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"
  })[c]);
}
function money(value){
  const n=Number(value);
  return new Intl.NumberFormat("en-IN",{style:"currency",currency:"INR"})
    .format(Number.isFinite(n)?n:0);
}
function date(value){
  const d=new Date(value);
  return value&&!Number.isNaN(d.getTime())?d.toLocaleString("en-IN"):"—";
}
function message(id,text,type=""){
  $(id).className=text?"notice "+type:"";
  $(id).textContent=text;
}
function globalMessage(text,type=""){
  message("globalMessage",text,type);
}

async function api(path,options={}){
  const headers={...(options.headers||{})};
  if(options.body!==undefined)headers["Content-Type"]="application/json";
  if(token())headers.Authorization="Bearer "+token();

  let response;
  try{
    response=await fetch(API+path,{...options,headers});
  }catch{
    throw Error("Server से कनेक्शन नहीं हो पाया। Render Logs चेक करें।");
  }

  const raw=await response.text();
  let data={};
  try{data=raw?JSON.parse(raw):{}}
  catch{data={error:raw||"Invalid server response"}}

  if(response.status===401){
    localStorage.removeItem(TOKEN_KEY);
    showLogin();
    throw Error(data.error||"Session समाप्त हुआ। फिर Login करें।");
  }
  if(!response.ok)throw Error(data.error||data.message||"Request failed");
  return data;
}

function showLogin(){
  $("adminView").classList.add("hidden");
  $("loginView").classList.remove("hidden");
}
function showAdmin(){
  $("loginView").classList.add("hidden");
  $("adminView").classList.remove("hidden");
}

$("loginForm").addEventListener("submit",async e=>{
  e.preventDefault();
  $("loginBtn").disabled=true;
  message("loginMessage","Login हो रहा है...");
  try{
    const response=await fetch(API+"/admin/login",{
      method:"POST",
      headers:{"Content-Type":"application/json"},
      body:JSON.stringify({password:$("password").value})
    });
    const data=await response.json();
    if(!response.ok)throw Error(data.error||"Login असफल हुआ");
    if(!data.token)throw Error("Server से Login token नहीं मिला");

    localStorage.setItem(TOKEN_KEY,data.token);
    $("password").value="";
    showAdmin();
    await loadAll();
    globalMessage("Login सफल हुआ","success");
  }catch(error){
    message("loginMessage",error.message,"error");
  }finally{
    $("loginBtn").disabled=false;
  }
});

$("logoutBtn").addEventListener("click",async()=>{
  try{await api("/admin/logout",{method:"POST"})}catch{}
  localStorage.removeItem(TOKEN_KEY);
  showLogin();
  message("loginMessage","आप Logout हो गए हैं","success");
});

async function checkSession(){
  if(!token()){showLogin();return}
  try{
    await api("/admin/check");
    showAdmin();
    await loadAll();
  }catch(error){
    showLogin();
    message("loginMessage",error.message,"error");
  }
}

async function loadAll(){
  globalMessage("Data लोड हो रहा है...");
  const results=await Promise.allSettled([loadProducts(),loadOrders()]);
  const errors=results.filter(x=>x.status==="rejected");
  if(errors.length){
    globalMessage(errors.map(x=>x.reason.message).join(" | "),"error");
  }else{
    globalMessage("Data अपडेट हो गया","success");
  }
  updateStats();
}
$("refreshBtn").addEventListener("click",loadAll);

async function loadProducts(){
  const data=await api("/products");
  if(!Array.isArray(data))throw Error("Products response सही नहीं है");
  products=data;
  renderProducts();
  updateStats();
}
async function loadOrders(){
  const data=await api("/orders");
  if(!Array.isArray(data))throw Error("Orders response सही नहीं है");
  orders=data;
  renderOrders();
  updateStats();

  if(selectedOrderId!==null){
    const order=orders.find(o=>String(o.id)===String(selectedOrderId));
    if(order)renderOrderDetails(order);
    else closeOrderPanel();
  }
}
function updateStats(){
  $("productCount").textContent=products.length;
  $("orderCount").textContent=orders.length;
  $("pendingCount").textContent=orders.filter(o=>o.status==="pending").length;
}

document.querySelectorAll("[data-tab]").forEach(button=>{
  button.addEventListener("click",()=>{
    document.querySelectorAll("[data-tab]").forEach(b=>
      b.classList.toggle("active",b===button)
    );
    $("ordersSection").classList.toggle("hidden",button.dataset.tab!=="orders");
    $("productsSection").classList.toggle("hidden",button.dataset.tab!=="products");
  });
});

function renderOrders(){
  const query=$("orderSearch").value.trim().toLowerCase();
  const status=$("orderFilter").value;
  const list=orders.filter(o=>{
    const matches=[o.id,o.customer_name,o.customer_email,o.phone]
      .some(v=>String(v??"").toLowerCase().includes(query));
    return matches&&(!status||o.status===status);
  });

  if(!list.length){
    $("ordersBody").innerHTML='<tr><td colspan="6">कोई Order नहीं मिला</td></tr>';
    return;
  }

  $("ordersBody").innerHTML=list.map(o=>`
    <tr>
      <td>#${esc(o.id)}</td>
      <td>${esc(o.customer_name)}<br><small>${esc(o.phone)}</small></td>
      <td>${money(o.total)}</td>
      <td><span class="badge">${esc(o.status)}</span></td>
      <td>${esc(date(o.created_at))}</td>
      <td><button data-view-order="${esc(o.id)}">Details</button></td>
    </tr>
  `).join("");
}
$("orderSearch").addEventListener("input",renderOrders);
$("orderFilter").addEventListener("change",renderOrders);

$("ordersBody").addEventListener("click",e=>{
  const button=e.target.closest("[data-view-order]");
  if(!button)return;
  const order=orders.find(o=>String(o.id)===button.dataset.viewOrder);
  if(order)renderOrderDetails(order);
});

function renderOrderDetails(o){
  selectedOrderId=o.id;
  $("orderPanel").classList.remove("hidden");
  $("orderTitle").textContent="Order #"+o.id;

  const items=Array.isArray(o.items)?o.items:[];
  $("orderDetails").innerHTML=`
    <div class="detail">
      <strong>Customer Details</strong>
      <p>Name: ${esc(o.customer_name)}</p>
      <p>Email: ${esc(o.customer_email)}</p>
      <p>Phone: ${esc(o.phone)}</p>
      <p>Address: ${esc(o.address)}</p>
      <p>Date: ${esc(date(o.created_at))}</p>
    </div>

    <div class="detail">
      <strong>Order Items</strong>
      ${items.map(i=>`<p>${esc(i.name)} × ${esc(i.quantity)} — ${money(i.line_total??Number(i.price)*Number(i.quantity))}</p>`).join("")}
      <hr><strong>Total: ${money(o.total)}</strong>
    </div>

    <div class="detail">
      <strong>Order Status</strong>
      <p>Current: <span class="badge">${esc(o.status)}</span></p>
      <label for="newStatus">Change Status</label>
      <select id="newStatus">
        ${STATUSES.map(s=>`<option value="${s}" ${s===o.status?"selected":""}>${s}</option>`).join("")}
      </select>
      <div class="actions" style="margin-top:10px">
        <button data-save-status="${esc(o.id)}">Save Status</button>
        <button class="success" data-quick-status="${esc(o.id)}" data-status="confirmed">Accept Order</button>
        <button class="danger" data-quick-status="${esc(o.id)}" data-status="rejected">Reject Order</button>
      </div>
    </div>

    <div class="detail">
      <strong>Payment Details</strong>
      <p>Method: ${esc(o.payment_method)}</p>
      <p>Status: <span class="badge">${esc(o.payment_status)}</span></p>
      <p>Reference: ${esc(o.payment_reference||"Not provided")}</p>
      <p class="muted">Payment approve करने से पहले वास्तविक भुगतान की पुष्टि करें।</p>
      <div class="actions">
        <button class="success" data-payment="${esc(o.id)}" data-payment-status="approved">Approve Payment</button>
        <button class="danger" data-payment="${esc(o.id)}" data-payment-status="rejected">Reject Payment</button>
        <button class="secondary" data-payment="${esc(o.id)}" data-payment-status="pending">Set Pending</button>
      </div>
    </div>

    <div class="detail">
      <strong>Customer Feedback</strong>
      <p>${esc(o.feedback||"अभी कोई Feedback नहीं")}</p>
    </div>
  `;
  $("orderPanel").scrollIntoView({behavior:"smooth",block:"start"});
}

$("orderDetails").addEventListener("click",async e=>{
  const quick=e.target.closest("[data-quick-status]");
  const save=e.target.closest("[data-save-status]");
  const pay=e.target.closest("[data-payment]");

  try{
    if(quick){
      await api("/orders/"+encodeURIComponent(quick.dataset.quickStatus)+"/status",{
        method:"PATCH",
        body:JSON.stringify({status:quick.dataset.status})
      });
      globalMessage("Order Status अपडेट हो गया","success");
      await loadOrders();
    }else if(save){
      const status=$("newStatus").value;
      await api("/orders/"+encodeURIComponent(save.dataset.saveStatus)+"/status",{
        method:"PATCH",
        body:JSON.stringify({status})
      });
      globalMessage("Order Status अपडेट हो गया","success");
      await loadOrders();
    }else if(pay){
      const id=pay.dataset.payment;
      const payment_status=pay.dataset.paymentStatus;
      const reference=orders.find(o=>String(o.id)===id)?.payment_reference||"";

      if(payment_status==="approved"&&
        !confirm("क्या आपने वास्तविक भुगतान verify कर लिया है?"))return;

      await api("/orders/"+encodeURIComponent(id)+"/payment",{
        method:"PATCH",
        body:JSON.stringify({payment_status,payment_reference:reference})
      });
      globalMessage("Payment Status अपडेट हो गया","success");
      await loadOrders();
    }
  }catch(error){
    globalMessage(error.message,"error");
  }
});

function closeOrderPanel(){
  selectedOrderId=null;
  $("orderPanel").classList.add("hidden");
  $("orderDetails").innerHTML="";
}
$("closeOrder").addEventListener("click",closeOrderPanel);

function renderProducts(){
  const query=$("productSearch").value.trim().toLowerCase();
  const list=products.filter(p=>(p.name||"").toLowerCase().includes(query));

  if(!list.length){
    $("productsBody").innerHTML='<tr><td colspan="4">कोई Product नहीं मिला</td></tr>';
    return;
  }

  $("productsBody").innerHTML=list.map(p=>`
    <tr>
      <td>${p.image?`<img class="product-img" src="${esc(p.image)}" alt="" loading="lazy">`:""}${esc(p.name)}</td>
      <td>${money(p.price)}</td>
      <td>${esc(p.id)}</td>
      <td><div class="actions">
        <button data-edit-product="${esc(p.id)}">Edit</button>
        <button class="danger" data-delete-product="${esc(p.id)}">Delete</button>
      </div></td>
    </tr>
  `).join("");
}
$("productSearch").addEventListener("input",renderProducts);

function openProductForm(p=null){
  editingProductId=p?p.id:null;
  $("productFormTitle").textContent=p?"Edit Product":"Add Product";
  $("productName").value=p?.name||"";
  $("productPrice").value=p?.price??"";
  $("productImage").value=p?.image||"";
  $("productFormWrap").classList.remove("hidden");
  message("productMessage","");
  $("productFormWrap").scrollIntoView({behavior:"smooth",block:"start"});
}
function closeProductForm(){
  editingProductId=null;
  $("productForm").reset();
  $("productFormWrap").classList.add("hidden");
  message("productMessage","");
}
$("addProductBtn").addEventListener("click",()=>openProductForm());
$("cancelProductBtn").addEventListener("click",closeProductForm);

$("productsBody").addEventListener("click",async e=>{
  const edit=e.target.closest("[data-edit-product]");
  const del=e.target.closest("[data-delete-product]");

  if(edit){
    const p=products.find(x=>String(x.id)===edit.dataset.editProduct);
    if(p)openProductForm(p);
  }

  if(del){
    const p=products.find(x=>String(x.id)===del.dataset.deleteProduct);
    if(!p||!confirm("क्या '"+p.name+"' Product delete करना है?"))return;
    try{
      await api("/products/"+encodeURIComponent(p.id),{method:"DELETE"});
      await loadProducts();
      globalMessage("Product delete हो गया","success");
    }catch(error){
      globalMessage(error.message,"error");
    }
  }
});

$("productForm").addEventListener("submit",async e=>{
  e.preventDefau
