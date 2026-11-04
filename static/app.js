const root = document.getElementById('view-root');
const shell = document.getElementById('app-shell');
const loginScreen = document.getElementById('login-screen');
let state = null;
let view = 'overview';
let selectedTableId = null;
let activeOrderId = null;
let categoryFilter = 'all';
let csrfToken = null;
let demoMode = true;
let noticeTimer = null;

const money = value => new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(Number(value || 0));
const esc = value => String(value ?? '').replace(/[&<>"']/g, char => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
const titleCase = value => String(value || '').replaceAll('_', ' ').replace(/\b\w/g, c => c.toUpperCase());
const activeOrder = () => state?.orders.find(order => order.id === activeOrderId) || null;
const currentTable = () => state?.tables.find(table => table.id === selectedTableId) || null;

async function api(path, options = {}) {
  const method = (options.method || 'GET').toUpperCase();
  const headers = { ...(options.headers || {}) };
  if (options.body !== undefined) headers['Content-Type'] = 'application/json';
  if (csrfToken && !['GET', 'HEAD', 'OPTIONS'].includes(method)) headers['X-CSRF-Token'] = csrfToken;
  let response;
  try {
    response = await fetch(path, { ...options, method, headers,
      body: options.body === undefined ? undefined : JSON.stringify(options.body) });
  } catch (_error) {
    throw new Error('Could not reach the RMS service. Check the connection and try again.');
  }
  const data = await response.json().catch(() => ({}));
  if (response.status === 401 && !demoMode) showLogin();
  if (!response.ok) throw new Error(data.error || `Request failed (${response.status})`);
  return data;
}

function showNotice(message, isError = false) {
  const el = document.getElementById('notice');
  el.textContent = message;
  el.classList.toggle('error', isError);
  el.classList.remove('hidden');
  clearTimeout(noticeTimer);
  noticeTimer = setTimeout(() => el.classList.add('hidden'), 3200);
}

function showLogin() {
  shell.classList.add('hidden');
  loginScreen.classList.remove('hidden');
  document.getElementById('login-password').focus();
}

function showApp() {
  loginScreen.classList.add('hidden');
  shell.classList.remove('hidden');
  document.getElementById('logout-button').classList.toggle('hidden', demoMode);
  document.getElementById('mode-label').textContent = demoMode ? 'Demo workspace' : 'Administrator';
}

async function loadSession() {
  const info = await api('/api/session');
  demoMode = Boolean(info.demo_mode);
  csrfToken = info.csrf_token;
  if (!info.authenticated) return showLogin();
  showApp();
  await refreshState();
}

async function refreshState() {
  state = await api('/api/state');
  if (activeOrderId && !state.orders.some(order => order.id === activeOrderId)) activeOrderId = null;
  document.getElementById('kitchen-count').textContent = state.orders.filter(o => o.status === 'sent_to_kitchen').length;
  render();
}

function render() {
  if (!state) return;
  const titles = { overview: 'Overview', pos: 'Point of sale', kitchen: 'Kitchen display', inventory: 'Inventory' };
  document.getElementById('page-title').textContent = titles[view];
  document.querySelectorAll('.nav-link').forEach(button => button.classList.toggle('active', button.dataset.view === view));
  document.getElementById('today-label').textContent = new Intl.DateTimeFormat(undefined, { weekday:'short', month:'short', day:'numeric' }).format(new Date());
  if (view === 'overview') root.innerHTML = renderOverview();
  if (view === 'pos') root.innerHTML = renderPos();
  if (view === 'kitchen') root.innerHTML = renderKitchen();
  if (view === 'inventory') root.innerHTML = renderInventory();
}

function pageHeading(kicker, title, subtitle, action = '') {
  return `<div class="page-heading"><div><p class="eyebrow">${esc(kicker)}</p><h1>${esc(title)}</h1><p class="heading-subtitle">${esc(subtitle)}</p></div>${action}</div>`;
}

function renderOverview() {
  const m = state.metrics;
  const lowText = m.low_stock ? `${m.low_stock} item${m.low_stock === 1 ? '' : 's'} at or below reorder point` : 'Stock levels look good';
  const occupied = state.tables.filter(t => t.status !== 'available').length;
  const recent = [...state.orders].sort((a,b) => b.created_at.localeCompare(a.created_at)).slice(0,5);
  const tables = state.tables.map(table => `<div class="floor-table"><button class="floor-table-open" data-action="open-table" data-id="${esc(table.id)}">
    <span class="table-top"><strong>${esc(table.label)}</strong><span class="pip ${esc(table.status)}">${esc(table.status)}</span></span>
    <small>${table.active_order ? `${table.active_order.items.length} item${table.active_order.items.length === 1 ? '' : 's'} · ${money(table.active_order.subtotal)}` : table.status === 'dirty' ? 'Needs reset' : 'Tap to open POS'}</small></button>${table.status === 'dirty' ? `<button class="button small danger-soft" data-action="clean-table" data-id="${esc(table.id)}">Reset table</button>` : ''}</div>`).join('');
  const tickets = recent.length ? recent.map(order => `<div class="ticket-row"><span class="ticket-badge">${esc(order.table_label || 'TO')}</span><span class="ticket-info"><strong>${order.items.length} item${order.items.length === 1 ? '' : 's'} · ${titleCase(order.status)}</strong><small>${esc(timeAgo(order.created_at))} · ${order.items.map(item => esc(item.name)).slice(0,2).join(', ')}</small></span><span class="ticket-total">${money(order.subtotal)}</span></div>`).join('') : `<div class="empty-state"><strong>No active tickets</strong>Open a table to start the next order.</div>`;
  return `${pageHeading('SERVICE OVERVIEW', greeting(), 'Here’s what’s happening across your restaurant today.', '<button class="button primary" data-action="go-pos"><span>＋</span> New order</button>')}
  <div class="metrics-grid">
    <article class="metric-card"><div class="metric-top">Cash sales today <span class="metric-icon">＄</span></div><div class="metric-value">${money(m.sales_today)}</div><div class="metric-note">Captured cash payments</div></article>
    <article class="metric-card"><div class="metric-top">Open tickets <span class="metric-icon">▤</span></div><div class="metric-value">${m.open_orders}</div><div class="metric-note">Orders currently in service</div></article>
    <article class="metric-card"><div class="metric-top">Tables in service <span class="metric-icon">▦</span></div><div class="metric-value">${occupied}<span style="font-size:13px;color:#9aa3a8;font-weight:500"> / ${state.tables.length}</span></div><div class="metric-note">${state.tables.length - occupied} available to seat</div></article>
    <article class="metric-card"><div class="metric-top">Stock attention <span class="metric-icon">⌁</span></div><div class="metric-value">${m.low_stock}</div><div class="metric-note ${m.low_stock ? 'alert' : ''}">${esc(lowText)}</div></article>
  </div>
  <div class="dashboard-grid">
    <section class="panel"><div class="panel-header"><div><h2>Floor at a glance</h2><p>Live table status</p></div><button class="text-button" data-action="go-pos">Open point of sale →</button></div><div class="floor-grid">${tables || '<div class="empty-state">Add tables to the floor plan.</div>'}</div><div style="display:flex;gap:14px;margin-top:14px;flex-wrap:wrap"><span class="pip available">Available</span><span class="pip seated">Seated</span><span class="pip ordered">Kitchen</span><span class="pip dirty">Needs reset</span></div></section>
    <div style="display:grid;gap:15px;align-content:start"><section class="panel"><div class="panel-header"><div><h2>Active tickets</h2><p>Orders in progress</p></div><button class="text-button" data-view="kitchen">Kitchen view →</button></div><div class="ticket-list">${tickets}</div></section>
    <section class="panel"><div class="panel-header"><div><h2>Quick actions</h2><p>Jump into a workflow</p></div></div><div class="quick-actions"><button class="quick-action" data-action="go-pos"><span class="quick-icon">＋</span><span><strong>Start a new order</strong><small>Choose a table and build a ticket</small></span></button><button class="quick-action" data-view="inventory"><span class="quick-icon">▦</span><span><strong>Review inventory</strong><small>${m.low_stock ? `${m.low_stock} stock item${m.low_stock === 1 ? '' : 's'} need attention` : 'Check stock and reorder points'}</small></span></button></div></section></div>
  </div>`;
}

function greeting() {
  const hour = new Date().getHours();
  return hour < 11 ? 'Good morning' : hour < 16 ? 'Good afternoon' : 'Good evening';
}

function renderPos() {
  const order = activeOrder();
  const selected = currentTable();
  const tableCards = state.tables.map(table => `<button class="table-card ${selectedTableId === table.id ? 'selected' : ''}" data-action="select-table" data-id="${esc(table.id)}"><div class="table-card-head"><strong>${esc(table.label)}</strong><span class="pill ${esc(table.status)}">${esc(table.status)}</span></div><div class="table-detail">${table.active_order ? `${table.active_order.items.length} items · ${money(table.active_order.subtotal)}` : table.status === 'dirty' ? 'Reset before seating' : 'Available'}</div></button>`).join('');
  const categories = ['all', ...new Set(state.menu.map(item => item.course))];
  const menuCards = state.menu.filter(item => item.is_available && (categoryFilter === 'all' || item.course === categoryFilter)).map(item => {
    const modifiers = item.modifiers.length ? `<select class="modifier-select" multiple aria-label="Modifiers for ${esc(item.name)}" title="Optional: hold Ctrl or Command to select multiple">${item.modifiers.map(mod => `<option value="${esc(mod.id)}">${esc(mod.name)}${mod.price_adjustment ? ` (+${money(mod.price_adjustment)})` : ''}</option>`).join('')}</select>` : '';
    return `<article class="menu-card" data-menu-card="${esc(item.id)}"><div class="menu-card-top"><div><h3>${esc(item.name)}</h3><p>${esc(item.default_station)} station</p></div><span class="menu-price">${money(item.base_price)}</span></div>${modifiers}<div class="menu-card-bottom"><span class="course-tag">${esc(item.course)}</span><button class="button small soft" data-action="add-item" data-id="${esc(item.id)}" ${!order || order.status !== 'open' ? 'disabled' : ''}>Add +</button></div></article>`;
  }).join('');
  let ticketPanel;
  if (!order) {
    ticketPanel = `<aside class="ticket-panel"><div class="ticket-head"><div class="ticket-head-row"><h2>${selected ? `Table ${esc(selected.label)}` : 'Order ticket'}</h2><span class="pill ${selected?.status || 'available'}">${selected ? esc(selected.status) : 'Choose a table'}</span></div><p>${selected?.active_order ? 'Select the open ticket below.' : 'Start a ticket to begin adding menu items.'}</p></div><div class="ticket-lines">${selected?.active_order ? `<button class="button secondary full" data-action="resume-order" data-id="${esc(selected.active_order.id)}">Resume ticket · ${money(selected.active_order.subtotal)}</button>` : '<div class="empty-state"><strong>No ticket selected</strong>Select an available table to open a new order.</div>'}</div>${selected && selected.status === 'available' ? `<div class="ticket-actions"><button class="button primary" data-action="start-ticket" data-id="${esc(selected.id)}">Start order at ${esc(selected.label)} <span>→</span></button></div>` : ''}</aside>`;
  } else {
    const itemMarkup = order.items.length ? order.items.map(item => `<div class="ticket-line"><span class="line-qty">${item.quantity}×</span><span class="line-desc"><strong>${esc(item.name)}</strong><small>${item.modifiers.map(mod => esc(mod.name)).join(', ') || esc(item.course)}</small></span><span class="line-amount">${money(item.line_total)}</span>${order.status === 'open' ? `<button class="remove-line" aria-label="Remove ${esc(item.name)}" data-action="remove-item" data-order="${esc(order.id)}" data-id="${esc(item.id)}">×</button>` : ''}</div>`).join('') : '<div class="empty-state"><strong>Ticket is empty</strong>Add items from the menu.</div>';
    const workflow = order.status === 'open' ? 'Add items and send the ticket when it is ready for the kitchen.' : order.all_ready ? 'Kitchen is ready. This ticket can be checked out.' : 'Kitchen is preparing this ticket. Mark every item ready in Kitchen before checkout.';
    const checkoutButton = order.status === 'sent_to_kitchen' ? `<button class="button primary" data-action="checkout" data-id="${esc(order.id)}" ${order.all_ready ? '' : 'disabled'}>Complete cash sale <span>→</span></button>` : `<button class="button dark" data-action="send-order" data-id="${esc(order.id)}" ${order.items.length ? '' : 'disabled'}>Send to kitchen <span>→</span></button>`;
    ticketPanel = `<aside class="ticket-panel"><div class="ticket-head"><div class="ticket-head-row"><h2>Table ${esc(order.table_label || 'Takeout')}</h2><span class="pill ${order.status === 'open' ? 'seated' : 'ordered'}">${titleCase(order.status)}</span></div><p>Ticket ${esc(order.id.slice(0,8).toUpperCase())} · ${esc(timeAgo(order.created_at))}</p></div><div class="ticket-lines">${itemMarkup}</div><div class="ticket-totals"><div class="total-row"><span>Subtotal</span><span>${money(order.subtotal)}</span></div><div class="total-row"><span>Tax</span><span>Not configured</span></div><div class="total-row grand"><span>Total</span><span>${money(order.subtotal)}</span></div></div><div class="order-workflow ${order.all_ready ? 'ready' : ''}">${esc(workflow)}</div><div class="ticket-actions">${checkoutButton}<button class="button secondary" data-action="clear-selection">Back to tables</button><p class="ticket-note">Cash only · Tax rules not configured · No card data handled</p></div></aside>`;
  }
  return `${pageHeading('FRONT OF HOUSE', 'Point of sale', 'Select a table, build the order, and send it to the kitchen.')}
  <div class="pos-layout"><div class="pos-left"><section class="section-card"><div class="section-title"><h2>1. Choose a table</h2><small>Select an available table or resume its ticket</small></div><div class="table-strip">${tableCards || '<div class="empty-state">No tables configured.</div>'}</div></section>
  <section class="section-card"><div class="section-title"><h2>2. Add menu items</h2><small>${order ? `Adding to ${esc(order.table_label || 'ticket')}` : 'Start or select a ticket first'}</small></div><div class="category-tabs">${categories.map(category => `<button class="category-tab ${categoryFilter === category ? 'active' : ''}" data-action="category" data-category="${esc(category)}">${titleCase(category)}</button>`).join('')}</div><div class="menu-grid">${menuCards || '<div class="empty-state">No available items in this category.</div>'}</div></section></div>${ticketPanel}</div>`;
}

function renderKitchen() {
  const orders = state.orders.filter(order => order.status === 'sent_to_kitchen');
  const cards = orders.map(order => {
    const held = order.items.filter(item => item.kds_status === 'HOLD');
    const lines = order.items.map(item => `<div class="kitchen-item"><span class="qty">${item.quantity}×</span><span>${esc(item.name)}<small>${item.modifiers.map(mod => esc(mod.name)).join(', ') || `${esc(item.station)} · ${esc(item.course)}`}</small></span>${item.kds_status === 'READY' ? '<span class="done">✓</span>' : item.kds_status === 'HOLD' ? '<span class="pill seated">HOLD</span>' : `<button class="button small soft" data-action="ready-item" data-id="${esc(item.id)}">Ready</button>`}</div>`).join('');
    return `<article class="ticket-card ${order.all_ready ? 'ready-ticket' : ''}"><div class="kitchen-ticket-head"><div><h3>Table ${esc(order.table_label || 'Takeout')}</h3><small>${esc(order.id.slice(0,8).toUpperCase())} · ${esc(timeAgo(order.created_at))}</small></div><span class="pill ${order.all_ready ? 'available' : 'ordered'}">${order.all_ready ? 'Ready' : 'In progress'}</span></div><div class="kitchen-items">${lines}</div><div class="kitchen-footer">${held.length ? `<button class="button small secondary" data-action="fire-order" data-id="${esc(order.id)}">Fire held items (${held.length})</button>` : ''}<button class="button small ${order.all_ready ? 'soft' : 'secondary'}" data-view="pos" data-order="${esc(order.id)}">${order.all_ready ? 'Ready for checkout' : 'View ticket'}</button></div></article>`;
  }).join('');
  return `${pageHeading('BACK OF HOUSE', 'Kitchen display', 'Track each ticket from fired to ready. Drinks and appetizers start immediately; entrees are held until fired.', '<span class="pill ordered">Live tickets · '+orders.length+'</span>')}
    ${orders.length ? `<div class="kitchen-grid">${cards}</div>` : `<section class="panel"><div class="empty-state"><div class="empty-icon">▤</div><strong>Kitchen is clear</strong>Tickets sent from the POS will appear here.</div></section>`}`;
}

function renderInventory() {
  const low = state.inventory.filter(item => item.low_stock).length;
  const rows = state.inventory.map(item => {
    const percent = item.par_level > 0 ? Math.min(100, Math.max(2, item.current_stock / item.par_level * 100)) : 100;
    return `<div class="inventory-row"><div class="inventory-name"><strong>${esc(item.name)}</strong><small>${esc(item.vendor_name || 'No vendor assigned')}</small></div><div><div class="stock-value">${formatQty(item.current_stock)} <small>${esc(item.unit_of_measure)}</small></div><div class="stock-meter"><span class="${item.low_stock ? 'low' : ''}" style="width:${percent}%"></span></div></div><div class="stock-meter-wrap"><span class="${item.low_stock ? 'pill seated' : 'pill available'}">${item.low_stock ? 'Reorder' : 'In stock'}</span><div class="low-note">ROP ${formatQty(item.reorder_point)} ${esc(item.unit_of_measure)}</div></div><button class="button small secondary" data-action="receive-stock" data-id="${esc(item.id)}">＋ Receive stock</button></div>`;
  }).join('');
  return `${pageHeading('STOCK CONTROL', 'Inventory', 'Keep an eye on ingredient levels and record deliveries or waste.', '<span class="pill '+(low ? 'seated' : 'available')+'">'+low+' need attention</span>')}
  <div class="inventory-summary"><div class="summary-chip"><strong>${state.inventory.length}</strong> tracked ingredients</div><div class="summary-chip"><strong>${low}</strong> below reorder point</div><div class="summary-chip"><strong>Live</strong> stock ledger enabled</div></div>
  <section class="section-card"><div class="section-title"><h2>Ingredient stock</h2><small>Adjustments are added to the inventory audit ledger</small></div><div class="inventory-list">${rows || '<div class="empty-state"><strong>No inventory items</strong>Add stock items to begin tracking.</div>'}</div></section>`;
}

function formatQty(value) {
  return new Intl.NumberFormat(undefined, { maximumFractionDigits: 2 }).format(Number(value || 0));
}

function timeAgo(value) {
  const date = new Date(String(value).replace(' ', 'T'));
  if (Number.isNaN(date.getTime())) return 'Just now';
  const minutes = Math.max(0, Math.floor((Date.now() - date.getTime()) / 60000));
  if (minutes < 1) return 'Just now';
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  return `${hours} hr${hours === 1 ? '' : 's'} ago`;
}

async function runAction(action, button) {
  const id = button.dataset.id;
  if (action === 'go-pos') { view = 'pos'; activeOrderId = null; render(); return; }
  if (action === 'open-table') { view = 'pos'; selectedTableId = id; activeOrderId = state.tables.find(t => t.id === id)?.active_order?.id || null; render(); return; }
  if (action === 'select-table') { selectedTableId = id; activeOrderId = state.tables.find(t => t.id === id)?.active_order?.id || null; render(); return; }
  if (action === 'clear-selection') { activeOrderId = null; selectedTableId = null; render(); return; }
  if (action === 'resume-order') { activeOrderId = id; selectedTableId = state.orders.find(o => o.id === id)?.table_id || selectedTableId; render(); return; }
  if (action === 'start-ticket') {
    const result = await api('/api/orders', { method: 'POST', body: { table_id: id } });
    selectedTableId = id; activeOrderId = result.id; await refreshState(); showNotice('New ticket started'); return;
  }
  if (action === 'category') { categoryFilter = button.dataset.category; render(); return; }
  if (action === 'add-item') {
    const card = button.closest('[data-menu-card]');
    const modifierIds = [...card.querySelectorAll('.modifier-select option:checked')].map(option => option.value);
    await api(`/api/orders/${activeOrderId}/items`, { method: 'POST', body: { menu_item_id: id, quantity: 1, modifier_ids: modifierIds } });
    await refreshState(); showNotice('Item added to ticket'); return;
  }
  if (action === 'remove-item') {
    await api(`/api/orders/${button.dataset.order}/items/${id}`, { method: 'DELETE' });
    await refreshState(); return;
  }
  if (action === 'send-order') {
    await api(`/api/orders/${id}/send`, { method: 'POST', body: {} });
    view = 'kitchen'; await refreshState(); showNotice('Ticket sent to kitchen'); return;
  }
  if (action === 'fire-order') {
    await api(`/api/orders/${id}/fire`, { method: 'POST', body: {} });
    await refreshState(); showNotice('Held items fired'); return;
  }
  if (action === 'ready-item') {
    await api(`/api/kitchen/items/${id}/ready`, { method: 'POST', body: {} });
    await refreshState(); showNotice('Item marked ready'); return;
  }
  if (action === 'checkout') {
    if (!window.confirm(`Complete this cash sale for ${money(activeOrder()?.subtotal)}? This records a cash payment and closes the ticket.`)) return;
    await api(`/api/orders/${id}/checkout`, { method: 'POST', body: {} });
    activeOrderId = null; selectedTableId = null; view = 'overview'; await refreshState(); showNotice('Cash sale completed · table needs reset'); return;
  }
  if (action === 'clean-table') {
    await api(`/api/tables/${id}/clean`, { method: 'POST', body: {} });
    await refreshState(); showNotice('Table is ready for the next party'); return;
  }
  if (action === 'receive-stock') {
    const item = state.inventory.find(row => row.id === id);
    const amount = window.prompt(`How many ${item.unit_of_measure} of ${item.name} were received?`, '1');
    if (amount === null) return;
    await api(`/api/inventory/${id}/adjust`, { method: 'POST', body: { quantity: amount, reason: 'restock' } });
    await refreshState(); showNotice('Stock updated and ledger entry recorded'); return;
  }
  if (action === 'logout') {
    await api('/api/logout', { method: 'POST', body: {} });
    csrfToken = null; showLogin(); return;
  }
}

root.addEventListener('click', async event => {
  const button = event.target.closest('[data-action], [data-view]');
  if (!button) return;
  if (button.dataset.view) {
    view = button.dataset.view;
    if (button.dataset.order) activeOrderId = button.dataset.order;
    render();
    return;
  }
  try { await runAction(button.dataset.action, button); }
  catch (error) { showNotice(error.message, true); }
});

document.querySelector('.main-nav').addEventListener('click', event => {
  const button = event.target.closest('[data-view]');
  if (!button) return;
  view = button.dataset.view;
  if (view !== 'pos') activeOrderId = null;
  render();
});

document.getElementById('refresh-button').addEventListener('click', async () => {
  try { await refreshState(); showNotice('Restaurant data refreshed'); }
  catch (error) { showNotice(error.message, true); }
});

document.getElementById('logout-button').addEventListener('click', async () => {
  try { await runAction('logout', document.getElementById('logout-button')); }
  catch (error) { showNotice(error.message, true); }
});

document.getElementById('login-form').addEventListener('submit', async event => {
  event.preventDefault();
  const errorNode = document.getElementById('login-error');
  errorNode.classList.add('hidden');
  try {
    const response = await fetch('/api/login', { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({ password:document.getElementById('login-password').value }) });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || 'Sign in failed');
    document.getElementById('login-password').value = '';
    await loadSession();
  } catch (error) { errorNode.textContent = error.message; errorNode.classList.remove('hidden'); }
});

loadSession().catch(error => {
  showLogin();
  const errorNode = document.getElementById('login-error');
  errorNode.textContent = error.message;
  errorNode.classList.remove('hidden');
});
