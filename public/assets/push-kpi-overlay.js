/**
 * Push KPI Overlay - Standalone Vanilla JS
 * Injects a floating dashboard on /p/admin/push without touching React bundle.
 * Includes authentication token extraction for API access.
 */
(function() {
  // Only run on push admin page
  if (!window.location.pathname.includes('/p/admin/push')) return;

  const style = document.createElement('style');
  style.textContent = `
    #push-kpi-overlay {
      position: fixed;
      top: 80px;
      right: 24px;
      z-index: 9999;
      background: #1a1a1a;
      border: 1px solid #333;
      border-radius: 12px;
      padding: 16px;
      box-shadow: 0 8px 32px rgba(0,0,0,0.4);
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      min-width: 280px;
      color: #fff;
    }
    #push-kpi-overlay .kpi-header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      margin-bottom: 12px;
      padding-bottom: 8px;
      border-bottom: 1px solid #333;
    }
    #push-kpi-overlay .kpi-title {
      font-size: 14px;
      font-weight: 600;
      color: #10b981;
    }
    #push-kpi-overlay .kpi-filters {
      display: flex;
      gap: 4px;
    }
    #push-kpi-overlay .kpi-btn {
      background: #2a2a2a;
      border: 1px solid #444;
      color: #aaa;
      padding: 4px 8px;
      border-radius: 6px;
      font-size: 11px;
      cursor: pointer;
      transition: all 0.2s;
    }
    #push-kpi-overlay .kpi-btn:hover {
      background: #333;
      color: #fff;
    }
    #push-kpi-overlay .kpi-btn.active {
      background: #10b981;
      border-color: #10b981;
      color: #fff;
    }
    #push-kpi-overlay .kpi-grid {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 12px;
    }
    #push-kpi-overlay .kpi-card {
      background: #252525;
      border-radius: 8px;
      padding: 12px;
      text-align: center;
    }
    #push-kpi-overlay .kpi-value {
      font-size: 24px;
      font-weight: 700;
      color: #fff;
      margin-bottom: 4px;
    }
    #push-kpi-overlay .kpi-label {
      font-size: 11px;
      color: #888;
      text-transform: uppercase;
      letter-spacing: 0.5px;
    }
    #push-kpi-overlay .kpi-loading {
      text-align: center;
      color: #666;
      font-size: 12px;
      padding: 20px;
    }
    #push-kpi-overlay .kpi-error {
      text-align: center;
      color: #ef4444;
      font-size: 12px;
      padding: 20px;
    }
  `;
  document.head.appendChild(style);

  const overlay = document.createElement('div');
  overlay.id = 'push-kpi-overlay';
  overlay.innerHTML = `
    <div class="kpi-header">
      <span class="kpi-title">📊 Métricas Push</span>
      <div class="kpi-filters">
        <button class="kpi-btn active" data-period="day">Hoje</button>
        <button class="kpi-btn" data-period="week">Semana</button>
        <button class="kpi-btn" data-period="month">Mês</button>
      </div>
    </div>
    <div class="kpi-content">
      <div class="kpi-loading">Carregando...</div>
    </div>
  `;
  document.body.appendChild(overlay);

  let currentPeriod = 'day';

  function getAdminToken() {
    // Try cookies first (same as lib/admin.js extractToken)
    const cookies = document.cookie || '';
    const match = cookies.match(/(?:adm_token|valore_admin_token|valore_session)=([^;]+)/i);
    if (match) return decodeURIComponent(match[1].trim());
    
    // Fallback to localStorage
    try {
      const stored = localStorage.getItem('admin_token') || localStorage.getItem('valore_admin_token');
      if (stored) return stored;
    } catch (e) {}
    
    return null;
  }

  async function fetchStats(period) {
    const content = overlay.querySelector('.kpi-content');
    content.innerHTML = '<div class="kpi-loading">Carregando...</div>';
    
    try {
      const token = getAdminToken();
      const headers = {};
      if (token) {
        headers['Authorization'] = `Bearer ${token}`;
      }
      
      const res = await fetch(`/api/push/stats?period=${period}`, { headers });
      
      if (!res.ok) {
        if (res.status === 401) {
          throw new Error('Não autorizado - faça login no painel admin');
        }
        throw new Error(`API error: ${res.status}`);
      }
      
      const data = await res.json();
      
      content.innerHTML = `
        <div class="kpi-grid">
          <div class="kpi-card">
            <div class="kpi-value">${data.totalSubscribers || 0}</div>
            <div class="kpi-label">Usuários Cadastrados</div>
          </div>
          <div class="kpi-card">
            <div class="kpi-value">${data.totalSent || 0}</div>
            <div class="kpi-label">Notificações Enviadas</div>
          </div>
        </div>
      `;
    } catch (err) {
      content.innerHTML = `<div class="kpi-error">${err.message || 'Erro ao carregar métricas'}</div>`;
      console.error('[push-kpi-overlay]', err);
    }
  }

  // Filter buttons
  overlay.querySelectorAll('.kpi-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      overlay.querySelectorAll('.kpi-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      currentPeriod = btn.dataset.period;
      fetchStats(currentPeriod);
    });
  });

  // Initial load
  fetchStats(currentPeriod);

  // Auto-refresh every 30 seconds
  setInterval(() => fetchStats(currentPeriod), 30000);
})();