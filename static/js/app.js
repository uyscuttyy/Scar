/**
 * SCAR Frontend — Memory-Aware Swap Agent
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
    activeScreen: 'connect',
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
    // Screens
    els.screenConnect = $('#screen-connect');
    els.screenSwap = $('#screen-swap');
    els.screenDecision = $('#screen-decision');
    els.screenHistory = $('#screen-history');

    // Connect
    els.btnConnect = $('#btn-connect');
    els.walletDisplay = $('#wallet-display');
    els.walletAddress = $('#wallet-address');
    els.walletChain = $('#wallet-chain');
    els.btnDisconnect = $('#btn-disconnect');

    // Swap
    els.fromAmount = $('#from-amount');
    els.fromTokenBtn = $('#from-token-btn');
    els.toTokenBtn = $('#to-token-btn');
    els.swapArrow = $('#swap-arrow');
    els.btnReview = $('#btn-review');
    els.quoteLoading = $('#quote-loading');
    els.quoteError = $('#quote-error');

    // Decision
    els.decisionBanner = $('#decision-banner');
    els.decisionIcon = $('#decision-icon');
    els.decisionTitle = $('#decision-title');
    els.decisionMessage = $('#decision-message');
    els.decisionDetails = $('#decision-details');
    els.decisionMemory = $('#decision-memory');
    els.btnConfirmSwap = $('#btn-confirm-swap');
    els.btnBackToSwap = $('#btn-back-to-swap');
    els.txStatus = $('#tx-status');

    // History
    els.historyList = $('#history-list');
    els.historyEmpty = $('#history-empty');

    // Modals
    els.tokenModal = $('#token-modal');
    els.tokenModalList = $('#token-modal-list');
    els.tokenModalTitle = $('#token-modal-title');

    // Global
    els.loadingOverlay = $('#loading-overlay');
    els.loadingText = $('#loading-text');
    els.globalError = $('#global-error');

    // Tabs
    els.tabSwap = $('#tab-swap');
    els.tabHistory = $('#tab-history');
  }

  // ──────────────────────────────────────────────────────────────
  // Helpers
  // ──────────────────────────────────────────────────────────────
  function fmtAddr(addr) {
    if (!addr) return '';
    const a = addr.toLowerCase();
    return a.slice(0, 6) + '…' + a.slice(-4);
  }

  function fmtNum(n, decimals = 4) {
    if (n === null || n === undefined || n === '') return '—';
    const num = Number(n);
    if (isNaN(num)) return '—';
    if (num === 0) return '0';
    if (num < 0.0001) return '< 0.0001';
    return num.toLocaleString(undefined, {
      minimumFractionDigits: 0,
      maximumFractionDigits: decimals
    });
  }

  function fmtBps(bps) {
    if (bps === null || bps === undefined) return '—';
    return (bps / 100).toFixed(2) + '%';
  }

  function fmtDate(iso) {
    if (!iso) return '—';
    try {
      return new Date(iso).toLocaleDateString(undefined, {
        month: 'short', day: 'numeric', year: 'numeric'
      });
    } catch { return iso; }
  }

  function showScreen(name) {
    state.activeScreen = name;
    $$('.screen').forEach(s => s.classList.remove('active'));
    $(`#screen-${name}`)?.classList.add('active');
    $$('.tab').forEach(t => t.classList.remove('active'));
    $(`#tab-${name}`)?.classList.add('active');
  }

  function setLoading(on, text = 'Loading…') {
    state.loading = on;
    els.loadingOverlay.classList.toggle('active', on);
    if (on) els.loadingText.textContent = text;
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
  // Wallet providers: EIP-6963 discovery + legacy fallback.
  // Multiple extensions fight over window.ethereum; discovery lets
  // the user pick the wallet that actually holds their funds.
  // ──────────────────────────────────────────────────────────────
  const discovered = []; // { info, provider }

  function eth() {
    return state.provider || window.ethereum;
  }

  function discoverProviders() {
    if (typeof window === 'undefined' || !window.addEventListener) return;
    window.addEventListener('eip6963:announceProvider', (e) => {
      const { info, provider } = e.detail || {};
      if (!info || !provider) return;
      if (discovered.some(d => d.info.uuid === info.uuid)) return;
      discovered.push({ info, provider });
      renderWalletPicker();
    });
    window.dispatchEvent(new Event('eip6963:requestProvider'));
  }

  function renderWalletPicker() {
    const box = document.getElementById('wallet-picker');
    if (!box) return;
    box.innerHTML = '';
    if (!discovered.length) return; // legacy single-button path
    discovered.forEach(({ info, provider }) => {
      const b = document.createElement('button');
      b.className = 'btn btn-secondary';
      b.style.cssText = 'width:100%;margin-top:0.5rem';
      b.textContent = `Connect ${info.name}`;
      b.addEventListener('click', () => {
        state.provider = provider;
        connectWallet();
      });
      box.appendChild(b);
    });
    if (els.btnConnect) els.btnConnect.textContent = 'Connect (default wallet)';
  }

  function showProviderInfo() {
    const el = document.getElementById('provider-info');
    if (!el) return;
    const names = discovered.map(d => d.info.name);
    const eth = window.ethereum;
    if (typeof eth === 'undefined' && !names.length) {
      el.textContent = 'provider: none detected';
      return;
    }
    const flags = [...names];
    if (eth) {
      if (eth.isMetaMask && !flags.includes('MetaMask')) flags.push('MetaMask');
      if (eth.isCoinbaseWallet) flags.push('Coinbase');
      if (eth.isBraveWallet) flags.push('Brave');
      if (eth.isPhantom) flags.push('Phantom');
    }
    el.textContent = 'provider: ' + (flags.join(', ') || 'unknown wallet');
  }

  async function checkWallet() {
    showProviderInfo();
    if (typeof eth() === 'undefined') {
      // EIP-6963 answers arrive async — give discovery a moment before
      // declaring no wallet.
      setTimeout(() => {
        showProviderInfo();
        renderWalletPicker();
        if (typeof eth() === 'undefined' && !discovered.length) {
          setGlobalError('No wallet detected. Install MetaMask, Coinbase Wallet, or another Web3 wallet.');
          els.btnConnect.disabled = true;
          els.btnConnect.textContent = 'Wallet Required';
        }
      }, 1500);
      return;
    }

    try {
      const accounts = await eth().request({ method: 'eth_accounts' });
      if (accounts.length > 0) {
        await connectWalletWithAddress(accounts[0]);
      }
    } catch (e) {
      console.warn('Wallet check failed:', e);
    }
  }

  async function connectWallet() {
    if (typeof eth() === 'undefined') {
      setGlobalError('No wallet detected. Please install a Web3 wallet.');
      return;
    }

    try {
      setLoading(true, 'Connecting wallet…');
      clearGlobalError();

      // If the wallet prompt hangs (locked wallet, blocked popup, wrong
      // extension answering), say so instead of spinning forever.
      const watchdog = setTimeout(() => {
        if (state.loading) {
          els.loadingText.textContent =
            'Still waiting — check your wallet extension for a pending ' +
            'prompt. Unlock your wallet and allow popups for this site.';
        }
      }, 15000);

      const accounts = await eth().request({
        method: 'eth_requestAccounts'
      });
      clearTimeout(watchdog);

      if (!accounts.length) throw new Error('No accounts returned');

      const chainId = await eth().request({ method: 'eth_chainId' });
      await switchToBaseSepolia(chainId);

      await connectWalletWithAddress(accounts[0]);
    } catch (e) {
      console.error('Connect failed:', e);
      setGlobalError(e.message || 'Failed to connect wallet');
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

    // Verify chain
    const chainId = await eth().request({ method: 'eth_chainId' });
    state.chainId = parseInt(chainId, 16);

    // Update UI
    els.walletAddress.textContent = fmtAddr(address);
    els.walletChain.textContent = state.chainId === CHAIN_ID
      ? 'Base Sepolia ✓'
      : `Wrong network (${state.chainId}) — switch to Base Sepolia`;
    els.walletChain.style.color = state.chainId === CHAIN_ID ? 'var(--success)' : 'var(--danger)';
    els.walletDisplay.style.display = 'flex';
    els.btnConnect.style.display = 'none';

    // Fetch balances
    await fetchBalances();

    // Show swap screen
    showScreen('swap');
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

    els.walletDisplay.style.display = 'none';
    els.btnConnect.style.display = 'inline-flex';
    els.fromAmount.value = '';
    showScreen('connect');
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

      // Evaluate with decision engine — send both the quoted slippage
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
      renderDecision(quote, decision);
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

  function renderDecision(quote, decision) {
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
        throw new Error(err.detail || 'Swap preparation failed');
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
          showTxStatus('pending', 'Approval needed — please sign to allow the swap.');
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

      if (receipt.status === 1) {
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
  // History
  // ──────────────────────────────────────────────────────────────
  async function loadHistory() {
    if (!state.wallet) return;

    try {
      const res = await fetch(`${API}/history?wallet=${state.wallet}`);
      if (!res.ok) throw new Error('History fetch failed');
      const data = await res.json();
      renderHistory(data.memories || []);
    } catch (e) {
      console.warn('History load failed:', e);
      els.historyList.innerHTML = '';
      els.historyEmpty.style.display = 'block';
    }
  }

  function renderHistory(memories) {
    if (!memories.length) {
      els.historyList.innerHTML = '';
      els.historyEmpty.style.display = 'block';
      return;
    }

    els.historyEmpty.style.display = 'none';
    els.historyList.innerHTML = memories.map(m => {
      const b = m.body || {};
      const badgeClass = (b.outcome || '').toLowerCase();
      return `
        <div class="memory-card">
          <div class="memory-header">
            <span class="memory-badge ${badgeClass}">${b.outcome || 'UNKNOWN'}</span>
            <span class="memory-pair">${b.pair || '—'}</span>
          </div>
          <div class="memory-meta">
            <span>${fmtNum(b.amount)} ${(b.pair || '').split('→')[0]?.trim() || ''}</span>
            <span>Slippage: ${fmtBps(b.slippageBps)}</span>
            <span>${fmtDate(b.ts)}</span>
            ${b.txHash ? `<span>Tx: ${fmtAddr(b.txHash)}</span>` : ''}
          </div>
        </div>
      `;
    }).join('');
  }

  // ──────────────────────────────────────────────────────────────
  // Event Listeners
  // ──────────────────────────────────────────────────────────────
  function bindEvents() {
    // Wallet
    els.btnConnect.addEventListener('click', connectWallet);
    els.btnDisconnect.addEventListener('click', disconnectWallet);

    // Token selection
    els.fromTokenBtn.addEventListener('click', () => openTokenModal('from'));
    els.toTokenBtn.addEventListener('click', () => openTokenModal('to'));
    els.swapArrow.addEventListener('click', swapTokens);

    // Modal
    els.tokenModal.addEventListener('click', e => {
      if (e.target === els.tokenModal) closeTokenModal();
    });

    // Amount
    els.fromAmount.addEventListener('input', e => {
      state.fromAmount = e.target.value;
      validateSwapForm();
    });

    // Review swap
    els.btnReview.addEventListener('click', fetchQuoteAndEvaluate);

    // Decision actions
    els.btnConfirmSwap.addEventListener('click', confirmSwap);
    els.btnBackToSwap.addEventListener('click', () => showScreen('swap'));

    // Tabs
    els.tabSwap.addEventListener('click', () => showScreen('swap'));
    els.tabHistory.addEventListener('click', async () => {
      showScreen('history');
      await loadHistory();
    });

    // Wallet events — attach to whichever provider answers.
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
    // Late discovery (extensions inject after load) — re-render picker.
    setTimeout(() => { renderWalletPicker(); showProviderInfo(); }, 1500);
    checkWallet();

    // Initial token button render
    updateTokenButton(els.fromTokenBtn, state.fromToken);
    updateTokenButton(els.toTokenBtn, state.toToken);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();