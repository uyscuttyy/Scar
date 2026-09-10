/**
 * SCAR Frontend: Memory-Aware Swap Agent
 * Vanilla JS, no build step. Connects to FastAPI backend.
 */
(function() {
  'use strict';

  // ──────────────────────────────────────────────────────────────
  // Config & Constants
  // ──────────────────────────────────────────────────────────────
  const API = '';
  const CHAIN_ID = 84532; // Base Sepolia
  const CHAIN_ID_HEX = '0x' + CHAIN_ID.toString(16);
  const EXPLORER = 'https://sepolia.basescan.org';

  // Verified Base Sepolia tokens (from architecture.md)
  const TOKENS = {
    USDC: {
      address: '0x036CbD53842c5426634e7929541eC2318f3dCF7e',
      symbol: 'USDC',
      name: 'USD Coin',
      decimals: 6,
      logo: '💵'
    },
    WETH: {
      address: '0x4200000000000000000000000000000000000006',
      symbol: 'WETH',
      name: 'Wrapped Ether',
      decimals: 18,
      logo: '🔷'
    }
  };
  const TOKEN_LIST = Object.values(TOKENS);
  const TOKEN_BY_ADDRESS = Object.fromEntries(TOKEN_LIST.map(t => [t.address.toLowerCase(), t]));
  const TOKEN_BY_SYMBOL = Object.fromEntries(TOKEN_LIST.map(t => [t.symbol, t]));

  // ──────────────────────────────────────────────────────────────
  // State
  // ──────────────────────────────────────────────────────────────
  const state = {
    wallet: null,
    chainId: null,
    connected: false,
    provider: null, // EIP-6963 selected provider, else window.ethereum
    balances: {},
    // Swap form
    fromToken: TOKENS.USDC,
    toToken: TOKENS.WETH,
    fromAmount: '',
    // Quote & decision
    currentQuote: null,
    currentDecision: null,
    currentTxHash: null,
    // UI
    activeScreen: 'home',
    loading: false,
    error: null
  };

  // ──────────────────────────────────────────────────────────────
  // DOM Elements
  // ──────────────────────────────────────────────────────────────
  const els = {};

  function $(sel, root = document) { return root.querySelector(sel); }
  function $$(sel, root = document) { return [...root.querySelectorAll(sel)]; }

  function cacheElements() {
      // Nav (anchor scroll, not tab screens)
      els.navLinks = $$('.nav-link[data-target]');

      // Wallet button in header
      els.walletButton = $('#wallet-button');
      els.walletLabel = $('#wallet-label');
      els.walletMenu = $('#wallet-menu');
      els.walletStatus = $('#wallet-status');

      // Hero CTAs
      els.btnStartTrade = $('#btn-start-trade');
      els.btnSeeHow = $('#btn-see-how');
      els.btnFinalStart = $('#btn-final-start');
      els.btnFinalScars = $('#btn-final-scars');

      // Hero demo card (live values, honest empty state)
      els.demoSlippage = $('#demo-slippage');
      els.demoImpact = $('#demo-impact');
      els.demoPrevious = $('#demo-previous');
      els.demoDecision = $('#demo-decision');
      els.demoTrySafer = $('#demo-try-safer');

      // Trade section elements
      els.fromAmount = $('#from-amount');
      els.fromTokenBtn = $('#from-token-btn');
      els.toTokenBtn = $('#to-token-btn');
      els.swapArrow = $('#swap-arrow');
      els.btnReview = $('#btn-review');
      els.quoteLoading = $('#quote-loading');
      els.quoteError = $('#quote-error');

      // Decision card elements
      els.decisionBanner = $('#decision-banner');
      els.decisionIcon = $('#decision-icon');
      els.decisionTitle = $('#decision-title-text');
      els.decisionMessage = $('#decision-message');
      els.decisionDetails = $('#decision-details');
      els.decisionMemory = $('#decision-memory');
      els.btnConfirmSwap = $('#btn-confirm-swap');
      els.btnBackToSwap = $('#btn-back-to-swap');
      els.txStatus = $('#tx-status');

      // Scars section elements
      els.historyList = $('#scars-list') || $('#scars-preview-list');
      els.historyEmpty = $('#scars-empty') || $('#scars-preview-empty');
      els.scarsSummary = $('#scars-summary');
      els.scarsPreviewList = $('#scars-preview-list');
      els.scarsPreviewEmpty = $('#scars-preview-empty');

      // Landing demo extras
      els.demoPairLabel = $('#demo-pair-label');
      els.demoAmount = $('#demo-amount');
      els.demoSourceNote = $('#demo-source-note');

      // How page
      els.specialistLive = $('#specialist-live');

      // Specialist
      els.decisionSpecialist = $('#decision-specialist');

      // Modals
      els.tokenModal = $('#token-modal');
      els.tokenModalList = $('#token-modal-list');
      els.tokenModalTitle = $('#token-modal-title');

      // Global
      els.loadingOverlay = $('#loading-overlay');
      els.loadingText = $('#loading-text');
      els.globalError = $('#global-error');

      // Back-compat aliases (old screen/tab model removed)
      els.screenHome = els.screenTrade = els.screenDecision = els.screenScars = els.screenSettings = null;
      els.tabHome = els.tabTrade = els.tabScars = els.tabSettings = null;
      els.homeWalletDisplay = els.homeWalletAddress = els.homeWalletChain = null;
      els.homeBtnDisconnect = els.homeBtnConnect = null;
      els.tradeWalletDisplay = els.tradeWalletAddress = els.tradeWalletChain = null;
      els.tradeBtnDisconnect = null;
      els.decisionWalletDisplay = els.decisionWalletAddress = els.decisionWalletChain = null;
      els.decisionBtnDisconnect = null;
      els.scarsWalletDisplay = els.scarsWalletAddress = els.scarsWalletChain = null;
      els.scarsBtnDisconnect = null;
      els.settingsWalletDisplay = els.settingsWalletAddress = els.settingsWalletChain = null;
      els.settingsBtnDisconnect = null;
      els.homeMeaningfulExperiences = els.homeAvoidedTrades = els.homeRecentExperience = null;
      els.homeBtnStartTrade = els.btnStartTrade;
      els.homeEmptyState = els.historyEmpty;
      els.homeDecisionMessage = els.demoDecision;
      els.homeScarRemembersList = els.historyList;
  }

  // Null-safe event helper: missing elements must never kill init.
  function on(el, evt, fn) { if (el) el.addEventListener(evt, fn); }

  // ──────────────────────────────────────────────────────────────
  // Helpers
  // ──────────────────────────────────────────────────────────────
  function fmtAddr(addr) {
    if (!addr) return '';
    const a = addr.toLowerCase();
    return a.slice(0, 6) + '…' + a.slice(-4);
  }

  function fmtNum(n, decimals = 4) {
    if (n === null || n === undefined || n === '') return '--';
    const num = Number(n);
    if (isNaN(num)) return '--';
    if (num === 0) return '0';
    if (num < 0.0001) return '< 0.0001';
    return num.toLocaleString(undefined, {
      minimumFractionDigits: 0,
      maximumFractionDigits: decimals
    });
  }

  function fmtBps(bps) {
    if (bps === null || bps === undefined) return '--';
    return (bps / 100).toFixed(2) + '%';
  }

  function fmtDate(iso) {
    if (!iso) return '--';
    try {
      return new Date(iso).toLocaleDateString(undefined, {
        month: 'short', day: 'numeric', year: 'numeric'
      });
    } catch { return iso; }
  }

  // Single-page model: nav scrolls to sections. Section ids double as
  // screen names ('trade', 'scars', 'decision', 'home' -> top).
  const SCREEN_TARGET = {
    home: '#hero', trade: '#trade', decision: '#decision-card',
    scars: '#your-scars', settings: '#trade', how: '#how-it-works'
  };
  function showScreen(name) {
    state.activeScreen = name;
    const sel = SCREEN_TARGET[name] || `#${name}`;
    const el = sel && $(sel);
    if (el) {
      el.scrollIntoView({ behavior: 'smooth', block: 'start' });
    } else {
      console.warn('showScreen: no target for', name);
    }
    if (els.navLinks) els.navLinks.forEach(a => {
      a.classList.toggle('active', a.dataset.target === sel);
    });

    // Update wallet displays on all screens when wallet state changes
    updateAllWalletDisplays();

    // Load per-page real data (fire and forget; each loader guards on wallet)
    if (name === 'home' || name === 'landing') loadLanding();
    if (name === 'scars') loadHistory();
  }

  function setLoading(on, text = 'Loading…') {
      state.loading = on;
      els.loadingOverlay.classList.toggle('active', on);
      if (on) els.loadingText.textContent = text;
  }

  function updateAllWalletDisplays() {
      // Header wallet button is the single source of truth.
      if (els.walletLabel) {
        els.walletLabel.textContent = state.wallet
          ? `${fmtAddr(state.wallet)}${state.chainId === CHAIN_ID ? '' : ' (wrong network)'}`
          : 'Connect Wallet';
      }
      if (els.walletButton) {
        els.walletButton.title = state.wallet
          ? (state.chainId === CHAIN_ID ? `Connected: ${state.wallet} (Base Sepolia). Click to disconnect.` : `Connected: ${state.wallet}. Wrong network, switch to Base Sepolia. Click to disconnect.`)
          : 'Connect a wallet';
      }
      if (!state.wallet) {
          // Hide all wallet displays
          if (els.homeWalletDisplay) els.homeWalletDisplay.style.display = 'none';
          if (els.homeBtnConnect) els.homeBtnConnect.style.display = 'inline-flex';
          if (els.tradeWalletDisplay) els.tradeWalletDisplay.style.display = 'none';
          if (els.decisionWalletDisplay) els.decisionWalletDisplay.style.display = 'none';
          if (els.scarsWalletDisplay) els.scarsWalletDisplay.style.display = 'none';
          if (els.settingsWalletDisplay) els.settingsWalletDisplay.style.display = 'none';
          return;
      }
      // Show wallet displays and hide connect button
      const address = fmtAddr(state.wallet);
      const chainText = state.chainId === CHAIN_ID ? 'Base Sepolia ✓' : `Wrong network (${state.chainId}): switch to Base Sepolia`;
      const chainColor = state.chainId === CHAIN_ID ? 'var(--success)' : 'var(--danger)';

      // Home
      if (els.homeWalletAddress) els.homeWalletAddress.textContent = address;
      if (els.homeWalletChain) {
          els.homeWalletChain.textContent = chainText;
          els.homeWalletChain.style.color = chainColor;
      }
      if (els.homeWalletDisplay) els.homeWalletDisplay.style.display = 'flex';
      if (els.homeBtnConnect) els.homeBtnConnect.style.display = 'none';
      if (els.homeBtnDisconnect) els.homeBtnDisconnect.style.display = 'inline-flex';

      // Trade
      if (els.tradeWalletAddress) els.tradeWalletAddress.textContent = address;
      if (els.tradeWalletChain) {
          els.tradeWalletChain.textContent = chainText;
          els.tradeWalletChain.style.color = chainColor;
      }
      if (els.tradeWalletDisplay) els.tradeWalletDisplay.style.display = 'flex';
      if (els.tradeBtnDisconnect) els.tradeBtnDisconnect.style.display = 'inline-flex';

      // Decision
      if (els.decisionWalletAddress) els.decisionWalletAddress.textContent = address;
      if (els.decisionWalletChain) {
          els.decisionWalletChain.textContent = chainText;
          els.decisionWalletChain.style.color = chainColor;
      }
      if (els.decisionWalletDisplay) els.decisionWalletDisplay.style.display = 'flex';
      if (els.decisionBtnDisconnect) els.decisionBtnDisconnect.style.display = 'inline-flex';

      // Scars
      if (els.scarsWalletAddress) els.scarsWalletAddress.textContent = address;
      if (els.scarsWalletChain) {
          els.scarsWalletChain.textContent = chainText;
          els.scarsWalletChain.style.color = chainColor;
      }
      if (els.scarsWalletDisplay) els.scarsWalletDisplay.style.display = 'flex';
      if (els.scarsBtnDisconnect) els.scarsBtnDisconnect.style.display = 'inline-flex';

      // Settings
      if (els.settingsWalletAddress) els.settingsWalletAddress.textContent = address;
      if (els.settingsWalletChain) {
          els.settingsWalletChain.textContent = chainText;
          els.settingsWalletChain.style.color = chainColor;
      }
      if (els.settingsWalletDisplay) els.settingsWalletDisplay.style.display = 'flex';
      if (els.settingsBtnDisconnect) els.settingsBtnDisconnect.style.display = 'inline-flex';
  }

  function setGlobalError(msg) {
    state.error = msg;
    if (msg) {
      els.globalError.textContent = msg;
      els.globalError.style.display = 'flex';
    } else {
      els.globalError.style.display = 'none';
    }
  }

  function clearGlobalError() { setGlobalError(null); }

  // ──────────────────────────────────────────────────────────────
  // Wallet Connection
  // ──────────────────────────────────────────────────────────────
  // EIP-6963 discovery + legacy fallback. The header button is the only
  // wallet control on every page. Every failure names its cause and fix.
  // ──────────────────────────────────────────────────────────────
  const PAGE = (document.body && document.body.dataset.page) || 'landing';
  const LAST_WALLET_KEY = 'scar.lastWallet';
  const discovered = []; // { info, provider }

  function eth() {
    return state.provider || window.ethereum;
  }

  function setWalletStatus(msg, kind) {
    if (!els.walletStatus) return;
    els.walletStatus.textContent = msg || '';
    els.walletStatus.dataset.kind = kind || '';
    els.walletStatus.style.display = msg ? 'block' : 'none';
  }

  function providerChoices() {
    const out = [...discovered];
    if (window.ethereum && !out.some(d => d.provider === window.ethereum)) {
      const name = window.ethereum.isMetaMask ? 'MetaMask'
        : window.ethereum.isCoinbaseWallet ? 'Coinbase Wallet'
        : window.ethereum.isPhantom ? 'Phantom' : 'Browser wallet';
      out.push({ info: { name, uuid: 'legacy' }, provider: window.ethereum });
    }
    return out;
  }

  function discoverProviders() {
    if (typeof window === 'undefined' || !window.addEventListener) return;
    window.addEventListener('eip6963:announceProvider', (e) => {
      const { info, provider } = e.detail || {};
      if (!info || !provider) return;
      if (discovered.some(d => d.info.uuid === info.uuid)) return;
      discovered.push({ info, provider });
      renderWalletMenu();
      refreshWalletStatus();
    });
    try { window.dispatchEvent(new Event('eip6963:requestProvider')); } catch {}
  }

  function renderWalletMenu() {
    const menu = els.walletMenu;
    if (!menu) return;
    const choices = providerChoices();
    menu.innerHTML = '';
    if (!state.wallet && choices.length > 1) {
      choices.forEach(({ info, provider }) => {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'wallet-menu-item';
        b.textContent = `Connect ${info.name}`;
        b.addEventListener('click', (ev) => {
          ev.stopPropagation();
          menu.hidden = true;
          state.provider = provider;
          connectWallet();
        });
        menu.appendChild(b);
      });
    }
  }

  function refreshWalletStatus() {
    if (state.wallet) {
      setWalletStatus(
        state.chainId === CHAIN_ID
          ? `Connected ${fmtAddr(state.wallet)} on Base Sepolia.`
          : `Connected ${fmtAddr(state.wallet)}, but on chain ${state.chainId}. Scar needs Base Sepolia.`,
        state.chainId === CHAIN_ID ? 'ok' : 'warn'
      );
      return;
    }
    const choices = providerChoices();
    if (!choices.length) {
      setWalletStatus('No wallet found in this browser. Install MetaMask or Coinbase Wallet, then reload.', 'warn');
    } else {
      setWalletStatus(`Found ${choices.map(c => c.info.name).join(', ')}. Click Connect Wallet.`, '');
    }
  }

  function renderWalletPicker() { renderWalletMenu(); refreshWalletStatus(); }
  function showProviderInfo() { refreshWalletStatus(); }

  function connectErrorMessage(e) {
    const code = e && e.code;
    if (code === 4001) return 'Connection rejected in the wallet. Click Connect Wallet and approve the request.';
    if (code === -32002) return 'A wallet request is already pending. Open your wallet extension and approve it.';
    if (code === 4902) return 'Base Sepolia is not in your wallet. Approve the add-network prompt.';
    if (code === -32603) return 'Wallet internal error. Unlock your wallet and try again.';
    return (e && e.message) || 'Failed to connect wallet.';
  }

  async function checkWallet() {
    refreshWalletStatus();
    const p = eth();
    if (typeof p === 'undefined') {
      // Extensions inject late: re-check once before declaring none.
      setTimeout(() => { renderWalletMenu(); refreshWalletStatus(); }, 1500);
      return;
    }
    // Silent auto-reconnect for a previously connected wallet.
    try {
      const accounts = await p.request({ method: 'eth_accounts' });
      let last = null;
      try { last = localStorage.getItem(LAST_WALLET_KEY); } catch {}
      if (accounts.length > 0 && last && accounts[0].toLowerCase() === last) {
        await connectWalletWithAddress(accounts[0]);
      } else {
        refreshWalletStatus();
      }
    } catch (e) {
      console.warn('Wallet check failed:', e);
      refreshWalletStatus();
    }
  }

  async function connectWallet() {
    const p = eth();
    if (typeof p === 'undefined') {
      setWalletStatus('No wallet found in this browser. Install MetaMask or Coinbase Wallet, then reload this page.', 'warn');
      setGlobalError('No wallet detected. Install MetaMask or Coinbase Wallet, then reload.');
      return;
    }

    // Several wallets installed: let the user pick which one answers.
    const choices = providerChoices();
    if (!state.provider && choices.length > 1 && els.walletMenu) {
      renderWalletMenu();
      els.walletMenu.hidden = false;
      setWalletStatus('Several wallets found. Choose which one to connect.', '');
      return;
    }

    try {
      setLoading(true, 'Connecting wallet…');
      clearGlobalError();
      setWalletStatus('Waiting for the wallet… approve the connection request.', '');

      const watchdog = setTimeout(() => {
        if (state.loading && els.loadingText) {
          els.loadingText.textContent =
            'Still waiting: check your wallet extension for a pending ' +
            'prompt. Unlock your wallet and allow popups for this site.';
        }
      }, 15000);

      const accounts = await p.request({ method: 'eth_requestAccounts' });
      clearTimeout(watchdog);

      if (!accounts.length) throw new Error('No accounts returned');

      const chainId = await p.request({ method: 'eth_chainId' });
      await switchToBaseSepolia(chainId);

      await connectWalletWithAddress(accounts[0]);
    } catch (e) {
      console.error('Connect failed:', e);
      const msg = connectErrorMessage(e);
      setGlobalError(msg);
      setWalletStatus(msg, 'warn');
    } finally {
      setLoading(false);
    }
  }

  async function switchToBaseSepolia(currentChainId) {
    if (parseInt(currentChainId, 16) === CHAIN_ID) return;

    try {
      await eth().request({
        method: 'wallet_switchEthereumChain',
        params: [{ chainId: CHAIN_ID_HEX }]
      });
    } catch (e) {
      if (e.code === 4902) {
        // Chain not added, add it
        await eth().request({
          method: 'wallet_addEthereumChain',
          params: [{
            chainId: CHAIN_ID_HEX,
            chainName: 'Base Sepolia',
            nativeCurrency: { name: 'ETH', symbol: 'ETH', decimals: 18 },
            rpcUrls: ['https://sepolia.base.org'],
            blockExplorerUrls: ['https://sepolia.basescan.org']
          }]
        });
      } else {
        throw e;
      }
    }
  }

  async function connectWalletWithAddress(address) {
    state.wallet = address.toLowerCase();
    state.connected = true;
    try { localStorage.setItem(LAST_WALLET_KEY, state.wallet); } catch {}

    // Verify chain
    try {
      const chainId = await eth().request({ method: 'eth_chainId' });
      state.chainId = parseInt(chainId, 16);
    } catch (e) {
      console.warn('Chain check failed:', e);
    }

    if (els.walletMenu) els.walletMenu.hidden = true;
    updateAllWalletDisplays();
    clearGlobalError();

    // Fetch balances (trade page shows them on the token buttons)
    await fetchBalances();

    // Refresh page-specific memory content now that the wallet is known.
    if (PAGE === 'landing') loadLanding();
    if (PAGE === 'scars') loadHistory();
  }

  async function disconnectWallet() {
    state.wallet = null;
    state.chainId = null;
    state.connected = false;
    state.provider = null;
    state.balances = {};
    state.fromAmount = '';
    state.currentQuote = null;
    state.currentDecision = null;
    try { localStorage.removeItem(LAST_WALLET_KEY); } catch {}

    if (els.fromAmount) els.fromAmount.value = '';
    if (els.walletMenu) els.walletMenu.hidden = true;
    updateAllWalletDisplays();
    refreshWalletStatus();
    if (PAGE === 'landing') loadLanding();
    if (PAGE === 'scars') loadHistory();
  }

  async function fetchBalances() {
    if (!state.wallet) return;

    try {
      // Fetch ETH balance
      const ethBal = await eth().request({
        method: 'eth_getBalance',
        params: [state.wallet, 'latest']
      });
      state.balances.ETH = parseInt(ethBal, 16) / 1e18;

      // Fetch USDC balance (ERC-20 balanceOf)
      const usdcData = '0x70a08231' + state.wallet.slice(2).padStart(64, '0');
      const usdcResult = await eth().request({
        method: 'eth_call',
        params: [{ to: TOKENS.USDC.address, data: usdcData }, 'latest']
      });
      state.balances.USDC = parseInt(usdcResult, 16) / 1e6;

      // Fetch WETH balance
      const wethResult = await eth().request({
        method: 'eth_call',
        params: [{ to: TOKENS.WETH.address, data: usdcData }, 'latest']
      });
      state.balances.WETH = parseInt(wethResult, 16) / 1e18;

      updateBalanceDisplay();
    } catch (e) {
      console.warn('Balance fetch failed:', e);
    }
  }

  function updateBalanceDisplay() {
    const fromBal = state.balances[state.fromToken.symbol] ?? 0;
    const toBal = state.balances[state.toToken.symbol] ?? 0;
    $('#from-balance')?.remove();
    $('#to-balance')?.remove();

    const fromBalEl = document.createElement('span');
    fromBalEl.id = 'from-balance';
    fromBalEl.className = 'token-balance';
    fromBalEl.textContent = fmtNum(fromBal, 6);
    els.fromTokenBtn.appendChild(fromBalEl);

    const toBalEl = document.createElement('span');
    toBalEl.id = 'to-balance';
    toBalEl.className = 'token-balance';
    toBalEl.textContent = fmtNum(toBal, 6);
    els.toTokenBtn.appendChild(toBalEl);
  }

  // ──────────────────────────────────────────────────────────────
  // Token Selection Modal
  // ──────────────────────────────────────────────────────────────
  let tokenModalTarget = null;

  function openTokenModal(target) {
    tokenModalTarget = target;
    els.tokenModalTitle.textContent = target === 'from' ? 'From Token' : 'To Token';
    renderTokenList();
    els.tokenModal.classList.add('active');
  }

  function closeTokenModal() {
    els.tokenModal.classList.remove('active');
    tokenModalTarget = null;
  }

  function renderTokenList() {
    els.tokenModalList.innerHTML = '';
    TOKEN_LIST.forEach(token => {
      const isFrom = tokenModalTarget === 'from';
      const isSelected = (isFrom ? state.fromToken : state.toToken).symbol === token.symbol;
      const balance = state.balances[token.symbol] ?? 0;

      // Don't show same token in both
      if (isFrom && token.symbol === state.toToken.symbol) return;
      if (!isFrom && token.symbol === state.fromToken.symbol) return;

      const btn = document.createElement('button');
      btn.className = 'token-option' + (isSelected ? ' selected' : '');
      btn.innerHTML = `
        <span style="font-size:1.25rem">${token.logo}</span>
        <div>
          <div class="token-symbol">${token.symbol}</div>
          <div class="token-name">${token.name}</div>
        </div>
        <span class="token-balance">${fmtNum(balance, 6)}</span>
      `;
      btn.addEventListener('click', () => selectToken(token));
      els.tokenModalList.appendChild(btn);
    });
  }

  function selectToken(token) {
    if (tokenModalTarget === 'from') {
      state.fromToken = token;
      updateTokenButton(els.fromTokenBtn, token);
    } else {
      state.toToken = token;
      updateTokenButton(els.toTokenBtn, token);
    }
    closeTokenModal();
    updateBalanceDisplay();
    validateSwapForm();
  }

  function updateTokenButton(btn, token) {
    btn.innerHTML = `
      <span style="font-size:1.25rem">${token.logo}</span>
      <div>
        <div class="token-symbol">${token.symbol}</div>
        <div class="token-name">${token.name}</div>
      </div>
    `;
    btn.dataset.token = token.symbol;
  }

  function swapTokens() {
    const tmp = state.fromToken;
    state.fromToken = state.toToken;
    state.toToken = tmp;
    updateTokenButton(els.fromTokenBtn, state.fromToken);
    updateTokenButton(els.toTokenBtn, state.toToken);
    updateBalanceDisplay();
    validateSwapForm();
  }

  // ──────────────────────────────────────────────────────────────
  // Swap Form Validation
  // ──────────────────────────────────────────────────────────────
  function validateSwapForm() {
    const amount = parseFloat(state.fromAmount);
    const hasAmount = !isNaN(amount) && amount > 0;
    const hasBalance = state.balances[state.fromToken.symbol] >= amount;
    const differentTokens = state.fromToken.symbol !== state.toToken.symbol;
    const correctChain = state.chainId === CHAIN_ID;

    els.btnReview.disabled = !(hasAmount && hasBalance && differentTokens && correctChain);

    if (!correctChain) {
      els.quoteError.textContent = 'Please switch to Base Sepolia network';
      els.quoteError.style.display = 'block';
    } else {
      els.quoteError.style.display = 'none';
    }
  }

  // ──────────────────────────────────────────────────────────────
  // Quote & Decision
  // ──────────────────────────────────────────────────────────────
  async function fetchQuoteAndEvaluate() {
    const amount = parseFloat(state.fromAmount);
    if (isNaN(amount) || amount <= 0) return;

    try {
      setLoading(true, 'Fetching quote…');
      clearGlobalError();
      els.quoteLoading.style.display = 'flex';
      els.quoteError.style.display = 'none';
      els.btnReview.disabled = true;

      // Get quote from backend
      const direction = 'sell'; // fromToken -> toToken
      const quoteRes = await fetch(`${API}/quote`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          wallet: state.wallet,
          fromToken: state.fromToken.address,
          toToken: state.toToken.address,
          amount,
          amountDecimals: state.fromToken.decimals
        })
      });

      if (!quoteRes.ok) {
        const err = await quoteRes.json().catch(() => ({}));
        throw new Error(err.detail || 'Quote failed');
      }

      const quote = await quoteRes.json();
      state.currentQuote = quote;

      // Evaluate with decision engine: send both the quoted slippage
      // tolerance and the measured price impact; the backend decides on
      // the worse of the two.
      const slippageBps = Math.round((1 - quote.minOutput / quote.expectedOutput) * 10000);
      const evalRes = await fetch(`${API}/evaluate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          wallet: state.wallet,
          pair: `${state.fromToken.symbol}-${state.toToken.symbol}`,
          direction,
          amount,
          slippage_bps: slippageBps,
          impact_bps: quote.priceImpactBps || 0
        })
      });

      if (!evalRes.ok) {
        const err = await evalRes.json().catch(() => ({}));
        throw new Error(err.detail || 'Evaluation failed');
      }

      const decision = await evalRes.json();
      state.currentDecision = decision;

      // Show decision screen
      renderDecision(quote, decision, amount);
      showScreen('decision');
    } catch (e) {
      console.error('Quote/eval failed:', e);
      els.quoteError.textContent = e.message || 'Failed to get quote';
      els.quoteError.style.display = 'block';
    } finally {
      setLoading(false);
      els.quoteLoading.style.display = 'none';
      els.btnReview.disabled = false;
    }
  }

  function renderDecision(quote, decision, amount) {
    // Banner
    els.decisionBanner.className = 'decision-banner ' + decision.decision.toLowerCase();

    const icons = {
      ALLOW: `<svg class="decision-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="20 6 9 17 4 12"></polyline></svg>`,
      DENY: `<svg class="decision-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg>`,
      SAFER_TERMS: `<svg class="decision-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"></path><line x1="12" y1="9" x2="12" y2="13"></line><line x1="12" y1="17" x2="12.01" y2="17"></line></svg>`
    };

    els.decisionIcon.innerHTML = icons[decision.decision] || icons.SAFER_TERMS;

    const titles = {
      ALLOW: 'SCAR ALLOWS THIS SWAP',
      DENY: 'SCAR BLOCKED THIS SWAP',
      SAFER_TERMS: 'SCAR RECOMMENDS SAFER TERMS'
    };
    els.decisionTitle.textContent = titles[decision.decision] || 'DECISION';
    els.decisionTitle.className = 'decision-title ' + decision.decision.toLowerCase();
    els.decisionMessage.textContent = decision.message || '';

    // Details
    const slip = quote.slippageBps || Math.round((1 - quote.minOutput / quote.expectedOutput) * 10000);
    // Hero demo card mirrors the live review (real values only).
    if (els.demoSlippage) els.demoSlippage.textContent = fmtBps(slip);
    if (els.demoImpact) els.demoImpact.textContent = fmtBps(quote.priceImpactBps || 0);
    if (els.demoPrevious) {
      els.demoPrevious.textContent = decision.memory
        ? `${decision.memory.outcome || 'Poor'} execution (${fmtBps(decision.memory.slippageBps)})`
        : 'No similar past trade';
    }
    if (els.demoDecision) {
      els.demoDecision.textContent =
        decision.decision === 'ALLOW' ? 'PROCEED' :
        decision.decision === 'DENY' ? 'DON’T REPEAT THIS' :
        'TRY SAFER TERMS';
    }
    // Persist the review so the landing demo card shows real values.
    try {
      localStorage.setItem('scar.lastDecision', JSON.stringify({
        pair: `${state.fromToken.symbol} → ${state.toToken.symbol}`,
        amount: `${fmtNum(amount)} ${state.fromToken.symbol}`,
        slippage: fmtBps(slip),
        impact: fmtBps(quote.priceImpactBps || 0),
        previous: decision.memory
          ? `${decision.memory.outcome || 'Poor'} execution (${fmtBps(decision.memory.slippageBps)})`
          : 'No similar past trade',
        decision: decision.decision === 'ALLOW' ? 'PROCEED'
          : decision.decision === 'DENY' ? 'DON’T REPEAT THIS' : 'TRY SAFER TERMS',
        when: new Date().toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })
      }));
    } catch {}
    els.decisionDetails.innerHTML = `
      <div class="detail-row"><span class="detail-label">Pair</span><span class="detail-value">${state.fromToken.symbol} → ${state.toToken.symbol}</span></div>
      <div class="detail-row"><span class="detail-label">Amount</span><span class="detail-value">${fmtNum(amount)} ${state.fromToken.symbol}</span></div>
      <div class="detail-row"><span class="detail-label">Expected Rate</span><span class="detail-value highlight">${fmtNum(quote.expectedRate)} ${state.toToken.symbol}/${state.fromToken.symbol}</span></div>
      <div class="detail-row"><span class="detail-label">Min Received</span><span class="detail-value">${fmtNum(quote.minOutput, 6)} ${state.toToken.symbol}</span></div>
      <div class="detail-row"><span class="detail-label">Slippage</span><span class="detail-value">${fmtBps(slip)}</span></div>
      <div class="detail-row"><span class="detail-label">Price Impact</span><span class="detail-value">${fmtBps(quote.priceImpactBps || 0)}</span></div>
    `;

    // Memory info
    if (decision.memory) {
      const m = decision.memory;
      els.decisionMemory.innerHTML = `
        <h3>Blocking Memory</h3>
        <div class="memory-card">
          <div class="memory-header">
            <span class="memory-badge ${m.outcome.toLowerCase()}">${m.outcome}</span>
            <span class="memory-pair">${state.fromToken.symbol} → ${state.toToken.symbol}</span>
          </div>
          <div class="memory-meta">
            <span>Previous slippage: ${fmtBps(m.slippageBps)}</span>
            <span>Outcome: ${m.outcome}</span>
            ${m.txHash ? `<span>Tx: ${fmtAddr(m.txHash)}</span>` : ''}
          </div>
        </div>
      `;
      els.decisionMemory.style.display = 'block';
    } else {
      els.decisionMemory.style.display = 'none';
    }

    // Actions
    if (decision.decision === 'ALLOW') {
      els.btnConfirmSwap.style.display = 'inline-flex';
      els.btnConfirmSwap.textContent = 'Confirm Swap';
      els.btnConfirmSwap.disabled = false;
    } else {
      els.btnConfirmSwap.style.display = 'none';
    }
    els.txStatus.style.display = 'none';

    // DENY / SAFER_TERMS: explicit zero-transaction guarantee + safer path.
    // The "Try safer terms" button applies the server-computed suggestion,
    // then runs a completely fresh quote → situation → Sibyl → evaluation.
    const sug = decision.safer_suggestion;
    let extra = '';
    if (decision.decision === 'DENY' || decision.decision === 'SAFER_TERMS') {
      extra += `<div class="detail-row"><span class="detail-label">Transaction submitted</span><span class="detail-value">None: zero transactions</span></div>`;
    }
    if (sug && sug.amount > 0) {
      extra += `
        <div class="detail-row"><span class="detail-label">Safer size</span><span class="detail-value highlight">${fmtNum(sug.amount)} ${state.fromToken.symbol}</span></div>
        <div class="detail-row"><span class="detail-label">Why safer</span><span class="detail-value" style="font-family:inherit">${sug.reason || ''}</span></div>
        <div style="margin-top:0.75rem">
          <button id="btn-try-safer" class="btn btn-secondary" type="button">Try ${fmtNum(sug.amount)} ${state.fromToken.symbol} instead</button>
        </div>`;
    }
    if (extra) {
      els.decisionDetails.innerHTML += extra;
      const tryBtn = $('#btn-try-safer');
      if (tryBtn) {
        tryBtn.addEventListener('click', async () => {
          state.fromAmount = String(sug.amount);
          if (els.fromAmount) els.fromAmount.value = String(sug.amount);
          validateSwapForm();
          showScreen('trade');
          await fetchQuoteAndEvaluate();
        });
      }
    }

    // Uncertain path: SAFER_TERMS with no blocking memory means Scar has
    // high risk and no experience to ground it. Offer a specialist check.
    // Advisory only: the result refines the suggestion, never authorizes.
    els.decisionSpecialist.style.display = 'none';
    els.decisionSpecialist.innerHTML = '';
    if (decision.decision === 'SAFER_TERMS' && !decision.memory) {
      const askRow = document.createElement('div');
      askRow.style.marginTop = '0.75rem';
      askRow.innerHTML = `<button id="btn-ask-specialist" class="btn btn-secondary" type="button">Ask a specialist agent</button>`;
      els.decisionDetails.appendChild(askRow);
      on($('#btn-ask-specialist'), 'click', () => askSpecialist(quote, decision));
    }
  }

  async function askSpecialist(quote, decision) {
    const box = els.decisionSpecialist;
    box.style.display = 'block';
    box.innerHTML = `<div class="memory-card"><div class="memory-meta"><span class="spinner"></span> Consulting specialist via Virtuals ACP…</div></div>`;
    try {
      const slip = quote.slippageBps || Math.round((1 - quote.minOutput / quote.expectedOutput) * 10000);
      const res = await fetch(`${API}/consult`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          wallet: state.wallet,
          pair: `${state.fromToken.symbol}-${state.toToken.symbol}`,
          direction: 'sell',
          amount: parseFloat(state.fromAmount),
          slippage_bps: slip,
          impact_bps: quote.priceImpactBps || 0,
          context: decision.message || ''
        })
      });
      const out = await res.json();
      if (!out.available) {
        box.innerHTML = `
          <h3>Specialist</h3>
          <div class="memory-card">
            <div class="memory-meta"><span>Unavailable: ${out.message || out.code || 'unknown'} Scar's decision stands.</span></div>
          </div>`;
        return;
      }
      const a = out.assessment || {};
      const cap = a.recommended_max_amount;
      const sugAmt = (decision.safer_suggestion && decision.safer_suggestion.amount) || 0;
      const refined = (cap && cap > 0) ? (sugAmt ? Math.min(sugAmt, cap) : cap) : 0;
      box.innerHTML = `
        <h3>Specialist says</h3>
        <div class="memory-card">
          <div class="memory-header">
            <span class="memory-badge ${(a.risk || 'unknown').toLowerCase()}">${a.risk || 'unknown'} risk</span>
            <span class="memory-pair">${out.provider_name || out.provider || 'specialist'}</span>
          </div>
          <div class="memory-meta"><span>${a.rationale || 'No rationale returned.'}</span></div>
          ${out.job_id ? `<div class="memory-meta"><span>ACP job ${out.job_id}</span></div>` : ''}
          ${refined ? `<div style="margin-top:0.75rem"><button id="btn-try-refined" class="btn btn-secondary" type="button">Try ${fmtNum(refined)} ${state.fromToken.symbol} instead</button></div>` : ''}
        </div>`;
      const rb = $('#btn-try-refined');
      if (rb) {
        rb.addEventListener('click', async () => {
          state.fromAmount = String(refined);
          if (els.fromAmount) els.fromAmount.value = String(refined);
          validateSwapForm();
          showScreen('trade');
          await fetchQuoteAndEvaluate();
        });
      }
    } catch (e) {
      box.innerHTML = `
        <h3>Specialist</h3>
        <div class="memory-card">
          <div class="memory-meta"><span>Consultation failed: ${e.message || e}. Scar's decision stands.</span></div>
        </div>`;
    }
  }

  // ──────────────────────────────────────────────────────────────
  // Transaction Execution
  // ──────────────────────────────────────────────────────────────
  async function confirmSwap() {
    if (!state.currentDecision || state.currentDecision.decision !== 'ALLOW') return;
    if (!state.currentQuote) return;

    try {
      setLoading(true, 'Preparing transaction…');
      clearGlobalError();
      els.btnConfirmSwap.disabled = true;
      els.btnConfirmSwap.textContent = 'Preparing…';

      // Get swap calldata from backend
      const swapRes = await fetch(`${API}/swap`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          wallet: state.wallet,
          fromToken: state.fromToken.address,
          toToken: state.toToken.address,
          amount: parseFloat(state.fromAmount),
          amountDecimals: state.fromToken.decimals,
          slippageBps: state.currentQuote.slippageBps || Math.round((1 - state.currentQuote.minOutput / state.currentQuote.expectedOutput) * 10000),
          quote: state.currentQuote
        })
      });

      if (!swapRes.ok) {
        const err = await swapRes.json().catch(() => ({}));
        const d = err.detail || {};
        // 403 = server-side decision gate refused (DENY/SAFER_TERMS/SIBYL_UNAVAILABLE).
        // Surface Scar's own message; no calldata was returned, nothing to sign.
        if (swapRes.status === 403 && d.decision) {
          state.currentDecision = d;
          renderDecision(state.currentQuote, d, parseFloat(state.fromAmount));
          showTxStatus('error', `Blocked by Scar: ${d.message || d.decision}. No transaction submitted.`);
          return;
        }
        throw new Error((d && d.message) || err.detail || 'Swap preparation failed');
      }

      const swapData = await swapRes.json();
      // swapData: { to, data, value, gasEstimate, approval, permit2 }

      // The router pulls input via direct transferFrom (router = spender),
      // so check wallet->router ERC20 allowance first and approve if needed.
      if (swapData.approval) {
        const allowanceData = '0xdd62ed3e'
          + state.wallet.slice(2).padStart(64, '0')
          + swapData.approval.spender.slice(2).padStart(64, '0');
        const allowRes = await eth().request({
          method: 'eth_call',
          params: [{ to: swapData.approval.to, data: allowanceData }, 'latest']
        });
        const allowed = BigInt(allowRes);
        const needed = BigInt(Math.floor(parseFloat(state.fromAmount) * (10 ** state.fromToken.decimals)));
        if (allowed < needed) {
          showTxStatus('pending', 'Approval needed: please sign to allow the swap.');
          const approveHash = await eth().request({
            method: 'eth_sendTransaction',
            params: [{
              from: state.wallet,
              to: swapData.approval.to,
              data: swapData.approval.data,
              value: '0x0'
            }]
          });
          state.currentTxHash = approveHash;
          showTxStatus('pending', 'Approval submitted. Confirming…');
          await waitForReceipt(approveHash);
        }
      }

      // Show pending
      showTxStatus('pending', 'Waiting for signature…');

      // Sign and send via wallet
      const txHash = await eth().request({
        method: 'eth_sendTransaction',
        params: [{
          from: state.wallet,
          to: swapData.to,
          data: swapData.data,
          value: swapData.value || '0x0',
          gas: swapData.gasEstimate ? '0x' + Number(swapData.gasEstimate).toString(16) : undefined
        }]
      });

      state.currentTxHash = txHash;
      showTxStatus('pending', 'Transaction submitted. Confirming…');

      // Wait for receipt
      const receipt = await waitForReceipt(txHash);

      if (receiptSucceeded(receipt)) {
        showTxStatus('success', 'Swap complete!');
        await handlePostSwap(receipt);
      } else {
        showTxStatus('error', 'Transaction failed on-chain');
        await handlePostSwap(receipt, true);
      }
    } catch (e) {
      console.error('Swap failed:', e);
      if (e.code === 4001) {
        showTxStatus('error', 'Transaction rejected by user');
      } else {
        showTxStatus('error', e.message || 'Transaction failed');
      }
    } finally {
      setLoading(false);
      els.btnConfirmSwap.disabled = false;
      els.btnConfirmSwap.textContent = 'Confirm Swap';
    }
  }

  function receiptSucceeded(receipt) {
    // Wallet providers return status hex ('0x1') while some paths give
    // number 1; accept every success encoding so a mined swap is never
    // misrecorded as FAILED.
    const s = receipt && receipt.status;
    return s === 1 || s === '0x1' || s === '0x01' || s === true;
  }

  function showTxStatus(type, title) {
    els.txStatus.className = 'tx-status ' + type;
    els.txStatus.querySelector('.tx-status-title').textContent = title;
    if (state.currentTxHash) {
      const short = fmtAddr(state.currentTxHash);
      const link = `${EXPLORER}/tx/${state.currentTxHash}`;
      els.txStatus.querySelector('.tx-hash').innerHTML = `Transaction: <a href="${link}" target="_blank" rel="noopener">${short}</a>`;
    }
    els.txStatus.style.display = 'block';
  }

  async function waitForReceipt(txHash, timeout = 120000) {
    const start = Date.now();
    while (Date.now() - start < timeout) {
      try {
        const receipt = await eth().request({
          method: 'eth_getTransactionReceipt',
          params: [txHash]
        });
        if (receipt) return receipt;
      } catch (e) {
        // Ignore, keep polling
      }
      await new Promise(r => setTimeout(r, 2000));
    }
    throw new Error('Receipt timeout');
  }

  async function handlePostSwap(receipt, failed = false) {
    // Evaluate outcome and record to Sibyl
    try {
      const outcome = failed ? 'FAILED' : 'GOOD'; // Simplified; real impl would compare actual vs expected
      const slippageBps = state.currentQuote?.slippageBps || 0;

      await fetch(`${API}/record`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          wallet: state.wallet,
          pair: `${state.fromToken.symbol}-${state.toToken.symbol}`,
          direction: 'sell',
          amount: parseFloat(state.fromAmount),
          slippageBps,
          impactBps: state.currentQuote?.priceImpactBps || 0,
          outcome,
          reason: failed ? 'Transaction reverted' : 'Successful execution',
          txHash: state.currentTxHash
        })
      });

      // Refresh history
      await loadHistory();
    } catch (e) {
      console.warn('Post-swap record failed:', e);
    }
  }

  // ──────────────────────────────────────────────────────────────
  // History: important experiences, never a transaction archive
  // ──────────────────────────────────────────────────────────────
  function scarWhyText(b, importance) {
    const parts = [];
    if (b.outcome === 'FAILED') parts.push('the transaction failed on-chain');
    else if (b.outcome === 'BAD') parts.push('execution was poor');
    else if (b.outcome === 'GOOD') parts.push('a good run retired an older warning');
    if ((b.slippageBps || 0) >= 200 || (b.impactBps || 0) >= 200) parts.push('conditions were harsh');
    parts.push(`importance ${importance}`);
    return 'Remembered because ' + parts.join(', ') + '.';
  }

  function scarEffectText(b) {
    if (b.outcome === 'BAD' || b.outcome === 'FAILED') {
      return 'A similar trade under similar conditions will be denied or offered safer terms.';
    }
    return 'Proves the safer path works; it can retire warnings it outperforms.';
  }

  function scarCard(m) {
    const b = m.body || {};
    const badgeClass = (b.outcome || '').toLowerCase();
    const tx = b.txHash
      ? `<span>Tx: <a href="${EXPLORER}/tx/${b.txHash}" target="_blank" rel="noopener">${fmtAddr(b.txHash)}</a></span>` : '';
    return `
      <div class="memory-card">
        <div class="memory-header">
          <span class="memory-badge ${badgeClass}">${b.outcome || 'UNKNOWN'}</span>
          <span class="memory-pair">${b.pair || '--'}${b.direction ? ' ' + String(b.direction).toUpperCase() : ''}</span>
        </div>
        <div class="memory-meta">
          <span>Size: ${fmtNum(b.amount)}${b.amountBucket ? ` (${b.amountBucket})` : ''}</span>
          <span>Slippage: ${fmtBps(b.slippageBps)}</span>
          ${b.impactBps ? `<span>Impact: ${fmtBps(b.impactBps)}</span>` : ''}
          <span>${fmtDate(b.ts)}</span>
          ${tx}
        </div>
        <p class="note" style="margin:0.6rem 0 0.25rem">${scarWhyText(b, m.importance || 0)}</p>
        <p class="note" style="margin:0">${scarEffectText(b)}</p>
      </div>
    `;
  }

  async function loadHistory() {
    if (!state.wallet) {
      if (els.historyList) els.historyList.innerHTML = '';
      if (els.historyEmpty) els.historyEmpty.style.display = 'block';
      if (els.scarsSummary) els.scarsSummary.textContent = 'Connect a wallet to see your scars.';
      return;
    }

    try {
      const res = await fetch(`${API}/history?wallet=${state.wallet}`);
      if (!res.ok) throw new Error('History fetch failed');
      const data = await res.json();
      renderHistory(data.memories || []);
    } catch (e) {
      console.warn('History load failed:', e);
      if (els.historyList) els.historyList.innerHTML = '';
      if (els.historyEmpty) els.historyEmpty.style.display = 'block';
      if (els.scarsSummary) els.scarsSummary.textContent = 'Could not load memories.';
    }
  }

  function renderHistory(memories) {
    const sorted = [...memories].sort((a, b) =>
      String((b.body || {}).ts || '').localeCompare(String((a.body || {}).ts || '')));
    const shown = PAGE === 'landing' ? sorted.slice(0, 3) : sorted;
    if (!els.historyList) return;
    if (!sorted.length) {
      els.historyList.innerHTML = '';
      if (els.historyEmpty) els.historyEmpty.style.display = 'block';
      if (els.scarsSummary) els.scarsSummary.textContent =
        state.wallet ? 'No scars yet. Make your first trade and Scar will remember what matters.' : 'Connect a wallet to see your scars.';
      return;
    }
    if (els.historyEmpty) els.historyEmpty.style.display = 'none';
    els.historyList.innerHTML = shown.map(scarCard).join('');
    if (els.scarsSummary) {
      const blockers = sorted.filter(m => ['BAD', 'FAILED'].includes((m.body || {}).outcome)).length;
      els.scarsSummary.textContent =
        `${sorted.length} meaningful experience${sorted.length === 1 ? '' : 's'} remembered. ` +
        `${blockers} poor-outcome trade${blockers === 1 ? '' : 's'} Scar will help you avoid repeating.`;
    }
  }

  // Landing: honest demo card + scars preview from real state.
  function lastDecision() {
    try { return JSON.parse(localStorage.getItem('scar.lastDecision') || 'null'); } catch { return null; }
  }

  async function loadLanding() {
    const d = lastDecision();
    if (d) {
      if (els.demoPairLabel) els.demoPairLabel.textContent = d.pair || 'USDC → WETH';
      if (els.demoAmount) els.demoAmount.textContent = d.amount || '--';
      if (els.demoSlippage) els.demoSlippage.textContent = d.slippage || '--';
      if (els.demoImpact) els.demoImpact.textContent = d.impact || '--';
      if (els.demoPrevious) els.demoPrevious.textContent = d.previous || 'No similar past trade';
      if (els.demoDecision) els.demoDecision.textContent = d.decision || 'Review a swap to see Scar decide';
      if (els.demoSourceNote) els.demoSourceNote.textContent = `Last reviewed${d.when ? ' on ' + d.when : ''}. Live values from your most recent review.`;
    }
    if (!state.wallet) {
      if (els.scarsPreviewList) els.scarsPreviewList.innerHTML = '';
      if (els.scarsPreviewEmpty) els.scarsPreviewEmpty.style.display = 'block';
      return;
    }
    try {
      const res = await fetch(`${API}/history?wallet=${state.wallet}`);
      if (!res.ok) throw new Error('History fetch failed');
      const data = await res.json();
      renderHistory(data.memories || []);
    } catch (e) {
      console.warn('Landing scars load failed:', e);
    }
  }

  async function loadSpecialistLive() {
    if (!els.specialistLive) return;
    try {
      const res = await fetch(`${API}/specialist/status`);
      const st = await res.json();
      els.specialistLive.textContent = st.configured
        ? 'Specialist network: available. Scar consults it when memory is thin.'
        : 'Specialist network: discovery only right now. Scar decides from memory unless a specialist is configured.';
    } catch {
      els.specialistLive.textContent = 'Specialist network: unreachable. Scar decides from memory alone.';
    }
  }

  // ──────────────────────────────────────────────────────────────
  // Event Listeners
  // ──────────────────────────────────────────────────────────────
  function bindEvents() {
    // Anchor nav: scroll to sections. Works with or without JS router.
    if (els.navLinks) els.navLinks.forEach(a => {
      a.addEventListener('click', () => {
        const sel = a.dataset.target;
        const el = sel && $(sel);
        if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' });
        els.navLinks.forEach(x => x.classList.remove('active'));
        a.classList.add('active');
      });
    });

    // Wallet: header button toggles connect/disconnect.
    on(els.walletButton, 'click', (ev) => {
      ev.stopPropagation();
      if (state.wallet) disconnectWallet();
      else connectWallet();
    });
    // Choosing a wallet from the menu must not toggle the button.
    document.addEventListener('click', (ev) => {
      if (els.walletMenu && !els.walletMenu.hidden && !els.walletMenu.contains(ev.target)) {
        els.walletMenu.hidden = true;
      }
    });

    // Token selection
    on(els.fromTokenBtn, 'click', () => openTokenModal('from'));
    on(els.toTokenBtn, 'click', () => openTokenModal('to'));
    on(els.swapArrow, 'click', swapTokens);

    // Modal
    on(els.tokenModal, 'click', e => {
      if (e.target === els.tokenModal) closeTokenModal();
    });

    // Amount
    on(els.fromAmount, 'input', e => {
      state.fromAmount = e.target.value;
      validateSwapForm();
    });

    // Review swap
    on(els.btnReview, 'click', fetchQuoteAndEvaluate);

    // Decision actions
    on(els.btnConfirmSwap, 'click', confirmSwap);
    on(els.btnBackToSwap, 'click', () => showScreen('trade'));

    // CTAs scroll to the real product sections
    on(els.btnStartTrade, 'click', () => showScreen('trade'));
    on(els.homeBtnStartTrade, 'click', () => showScreen('trade'));
    on(els.btnSeeHow, 'click', () => showScreen('how'));
    on(els.btnFinalStart, 'click', () => showScreen('trade'));
    on(els.btnFinalScars, 'click', () => showScreen('scars'));
    on(els.demoTrySafer, 'click', () => showScreen('trade'));

    // Wallet events: attach to whichever provider answers.
    const evProvider = eth();
    if (evProvider && evProvider.on) {
      evProvider.on('accountsChanged', accounts => {
        if (accounts.length === 0) disconnectWallet();
        else connectWalletWithAddress(accounts[0]);
      });
      evProvider.on('chainChanged', () => window.location.reload());
    }
  }

  // ──────────────────────────────────────────────────────────────
  // Init
  // ──────────────────────────────────────────────────────────────
  function init() {
    cacheElements();
    bindEvents();
    discoverProviders();
    // Late discovery (extensions inject after load): re-render picker.
    setTimeout(() => { renderWalletPicker(); showProviderInfo(); }, 1500);
    checkWallet();

    if (PAGE === 'trade') {
      // Initial token button render
      if (els.fromTokenBtn) updateTokenButton(els.fromTokenBtn, state.fromToken);
      if (els.toTokenBtn) updateTokenButton(els.toTokenBtn, state.toToken);
    }
    if (PAGE === 'landing') loadLanding();
    if (PAGE === 'scars') loadHistory();
    if (PAGE === 'how') loadSpecialistLive();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();