import React, { useRef, useEffect, useState } from "react";
import { io } from "socket.io-client";

/** --- Pump.fun Contract (hard-coded) --- */
const CONTRACT_ADDRESS = "37gh3B2RYV3vAvnUEmVMkaskMtUZwyqogXzV22fRpump";
const PUMPFUN_URL = `https://pump.fun/coin/${CONTRACT_ADDRESS}`;

/** Access policy */
const DEMO_LIMIT = 10;          // strokes allowed for demo users
const REQUIRED_TOKENS = 100_000; // must hold ≥100,000 tokens

/** Solana RPC (PublicNode) */
const RPC_URL = "https://solana-rpc.publicnode.com";

/** Backend URL resolution (from your original) */
const BACKEND_URL =
  (typeof window !== "undefined" && window.PUMP_BACKEND_URL) ||
  process.env.REACT_APP_BACKEND_URL ||
  "";

/** Socket **/
const socket = io(BACKEND_URL, {
  transports: ["websocket"],
  withCredentials: false,
  reconnection: true,
  reconnectionAttempts: Infinity,
});

/** Utils **/
function dist(a, b) {
  const dx = a.x - b.x,
    dy = a.y - b.y;
  return Math.sqrt(dx * dx + dy * dy);
}

export default function App() {
  const canvasRef = useRef(null);
  const ctxRef = useRef(null);

  // view
  const scaleRef = useRef(1);
  const offsetRef = useRef({ x: 0, y: 0 });

  // HUD
  const [hud, setHud] = useState({
    scale: 1,
    offsetX: 0,
    offsetY: 0,
    strokes: 0,
  });
  const [connected, setConnected] = useState(false);
  const [connMsg, setConnMsg] = useState("connecting…");

  // tool state (controlled) + refs so listeners see latest values without re-init
  const [color, setColor] = useState("#111111");
  const [size, setSize] = useState(3);
  const colorRef = useRef(color);
  const sizeRef = useRef(size);
  useEffect(() => {
    colorRef.current = color;
  }, [color]);
  useEffect(() => {
    sizeRef.current = size;
  }, [size]);

  // interaction
  const drawingRef = useRef(false);
  const panningRef = useRef(false);
  const lastPos = useRef({ x: 0, y: 0 });
  const panStart = useRef({ x: 0, y: 0 });
  const offsetStart = useRef({ x: 0, y: 0 });
  const lastEmit = useRef(0);

  // DPR
  const dprRef = useRef(1);

  // world
  const BALL_RADIUS = 2000;
  const WORLD_SIZE = BALL_RADIUS * 2 + 200;

  // strokes (for HUD only)
  const strokesRef = useRef([]);

  // queues/flags
  const incomingQueue = useRef([]);
  const needsRender = useRef(true);

  /** --------- Toast (no libs) ---------- */
  const [toast, setToast] = useState({ show: false, msg: "" });
  const toastTimer = useRef(null);
  function showToast(msg, ms = 1600) {
    setToast({ show: true, msg });
    if (toastTimer.current) clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(
      () => setToast({ show: false, msg: "" }),
      ms
    );
  }

  /** --------- Offscreen buffer (no-reset, infinite strokes) ---------- */
  const bufferCanvasRef = useRef(null);
  const bufferCtxRef = useRef(null);
  const BUF_SIZE = WORLD_SIZE;

  function worldToBuffer(x, y) {
    return { bx: x + BUF_SIZE / 2, by: y + BUF_SIZE / 2 };
  }

  function drawStrokeToBuffer(s) {
    const bctx = bufferCtxRef.current;
    if (!bctx) return;
    const p0 = worldToBuffer(s.x0, s.y0);
    const p1 = worldToBuffer(s.x1, s.y1);
    bctx.beginPath();
    bctx.moveTo(p0.bx, p0.by);
    bctx.lineTo(p1.bx, p1.by);
    bctx.strokeStyle = s.color || "#111";
    bctx.lineWidth = s.size || 3;
    bctx.lineCap = "round";
    bctx.lineJoin = "round";
    bctx.stroke();
  }

  /** -------- Wallet gate (Phantom + RPC check) ---------- */
  const [walletAddr, setWalletAddr] = useState(null);
  const [hasFullAccess, setHasFullAccess] = useState(false);
  const [demoUsed, setDemoUsed] = useState(0);
  const [checkingHoldings, setCheckingHoldings] = useState(false);
  const [rpcNote, setRpcNote] = useState("");

  async function rpc(method, params) {
    const body = { jsonrpc: "2.0", id: Date.now(), method, params };
    const res = await fetch(RPC_URL, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    const json = await res.json();
    if (json.error) throw new Error(json.error.message || "RPC error");
    return json.result;
  }

  async function connectWallet() {
    try {
      const provider = window.solana;
      if (!provider || !provider.isPhantom) {
        showToast("Phantom wallet not found.");
        return;
      }
      const resp = await provider.connect();
      const address = resp.publicKey?.toBase58?.() || null;
      setWalletAddr(address || null);
      if (address) await checkHoldings(address);
    } catch (e) {
      console.error("Wallet connect error", e);
      showToast("Wallet connect failed.");
    }
  }

  async function disconnectWallet() {
    try {
      const provider = window.solana;
      if (provider?.disconnect) {
        await provider.disconnect();
      }
    } catch (_) {
      // ignore phantom quirks
    } finally {
      setWalletAddr(null);
      setHasFullAccess(false);
      setDemoUsed(0);
      setRpcNote("");
      showToast("Wallet disconnected");
    }
  }

  async function checkHoldings(address) {
    setCheckingHoldings(true);
    setRpcNote("");
    try {
      // Holder token accounts for this mint
      const accts = await rpc("getTokenAccountsByOwner", [
        address,
        { mint: CONTRACT_ADDRESS },
        { encoding: "jsonParsed" },
      ]);

      let holderAmount = 0;
      for (const a of accts.value || []) {
        const tok = a.account?.data?.parsed?.info?.tokenAmount;
        if (tok?.uiAmount) holderAmount += Number(tok.uiAmount);
      }

      const pass = holderAmount >= REQUIRED_TOKENS;
      setHasFullAccess(pass);

      if (pass) {
        setRpcNote(`Verified: ${holderAmount.toLocaleString()} tokens`);
        showToast("Access granted ✅");
      } else {
        setRpcNote(
          `Need at least 100,000 tokens. You have ${holderAmount.toLocaleString()}.`
        );
        showToast("Need ≥ 100,000 tokens for full access.");
      }
    } catch (e) {
      console.error("checkHoldings failed", e);
      setHasFullAccess(false);
      setRpcNote("Holdings check failed. Using demo mode.");
      showToast("Holdings check failed. Demo mode.");
    } finally {
      setCheckingHoldings(false);
    }
  }

  const canDrawNow = () => (hasFullAccess ? true : demoUsed < DEMO_LIMIT);
  function countDemoUse() {
    if (!hasFullAccess) setDemoUsed((n) => Math.min(DEMO_LIMIT, n + 1));
  }

  // screen -> world
  function toWorld(clientX, clientY) {
    const canvas = canvasRef.current;
    const rect = canvas.getBoundingClientRect();
    const cssX = clientX - rect.left;
    const cssY = clientY - rect.top;
    const { x: ox, y: oy } = offsetRef.current;
    const s = scaleRef.current;
    const worldX = (cssX - canvas.clientWidth / 2) / s - ox;
    const worldY = (cssY - canvas.clientHeight / 2) / s - oy;
    return { x: worldX, y: worldY };
  }

  /** Fit-on-load helper */
  function resetViewToBall(canvas) {
    const margin = 40; // px margin around the ball
    const ballDiameter = BALL_RADIUS * 2;
    const scaleX = (canvas.clientWidth - margin * 2) / ballDiameter;
    const scaleY = (canvas.clientHeight - margin * 2) / ballDiameter;
    scaleRef.current = Math.min(scaleX, scaleY);
    offsetRef.current = { x: 0, y: 0 }; // center the ball at origin
    needsRender.current = true;
  }

  /** Setup once (do NOT depend on color/size to prevent resets) **/
  useEffect(() => {
    const canvas = canvasRef.current;
    const ctx = canvas.getContext("2d");
    ctxRef.current = ctx;

    // init buffer
    const b = document.createElement("canvas");
    b.width = BUF_SIZE;
    b.height = BUF_SIZE;
    const bctx = b.getContext("2d");
    bctx.save();
    bctx.beginPath();
    bctx.arc(BUF_SIZE / 2, BUF_SIZE / 2, BALL_RADIUS, 0, Math.PI * 2);
    bctx.clip();
    bctx.fillStyle = "#ffffff";
    bctx.fillRect(0, 0, BUF_SIZE, BUF_SIZE);
    bctx.restore();
    bufferCanvasRef.current = b;
    bufferCtxRef.current = bctx;

    const resize = () => {
      const dpr = Math.max(1, window.devicePixelRatio || 1);
      dprRef.current = dpr;
      const cssW = window.innerWidth;
      const cssH = window.innerHeight;
      canvas.width = Math.floor(cssW * dpr);
      canvas.height = Math.floor(cssH * dpr);
      canvas.style.width = cssW + "px";
      canvas.style.height = cssH + "px";
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      needsRender.current = true;
    };
    window.addEventListener("resize", resize, { passive: true });
    resize();
    resetViewToBall(canvas); // ensure first view shows full ball

    // zoom
    const onWheel = (e) => {
      e.preventDefault();
      const delta = -e.deltaY;
      const zoomIntensity = 0.0015;
      const s0 = scaleRef.current;
      const s1 = Math.min(5, Math.max(0.2, s0 * (1 + delta * zoomIntensity)));
      const before = toWorld(e.clientX, e.clientY);
      scaleRef.current = s1;
      const after = toWorld(e.clientX, e.clientY);
      offsetRef.current = {
        x: offsetRef.current.x + (after.x - before.x),
        y: offsetRef.current.y + (after.y - before.y),
      };
      needsRender.current = true;
    };
    canvas.addEventListener("wheel", onWheel, { passive: false });

    // pointer input
    const onPointerDown = (e) => {
      canvas.setPointerCapture?.(e.pointerId);
      if (
        e.button === 1 ||
        e.button === 2 ||
        e.shiftKey ||
        e.altKey ||
        e.metaKey ||
        e.ctrlKey
      ) {
        panningRef.current = true;
        panStart.current = { x: e.clientX, y: e.clientY };
        offsetStart.current = { ...offsetRef.current };
        return;
      }
      if (!canDrawNow()) {
        showToast("Need 100,000 tokens to keep drawing — demo limit reached.");
        return;
      }
      drawingRef.current = true;
      lastPos.current = toWorld(e.clientX, e.clientY);
      countDemoUse();
    };

    const onPointerMove = (e) => {
      if (panningRef.current) {
        const s = scaleRef.current;
        offsetRef.current = {
          x: offsetStart.current.x + (e.clientX - panStart.current.x) / s,
          y: offsetStart.current.y + (e.clientY - panStart.current.y) / s,
        };
        needsRender.current = true;
        return;
      }
      if (!drawingRef.current || !connected) return;
      if (!canDrawNow()) return;

      const now = performance.now();
      const p = toWorld(e.clientX, e.clientY);
      if (dist(p, lastPos.current) < 1 && now - lastEmit.current < 12) return;

      const stroke = {
        x0: lastPos.current.x,
        y0: lastPos.current.y,
        x1: p.x,
        y1: p.y,
        color: colorRef.current,
        size: sizeRef.current,
      };
      drawStrokeToBuffer(stroke);
      strokesRef.current.push(stroke);
      incomingQueue.current.push(null);
      socket.emit("draw", stroke);

      lastPos.current = p;
      lastEmit.current = now;
    };

    const onPointerUp = () => {
      drawingRef.current = false;
      panningRef.current = false;
    };

    canvas.addEventListener("pointerdown", onPointerDown);
    canvas.addEventListener("pointermove", onPointerMove);
    canvas.addEventListener("pointerup", onPointerUp);
    canvas.addEventListener("pointerleave", onPointerUp);
    canvas.addEventListener("pointercancel", onPointerUp);
    canvas.addEventListener("contextmenu", (e) => e.preventDefault());
    canvas.style.touchAction = "none";

    // socket events
    socket.on("connect", () => {
      setConnected(true);
      setConnMsg("connected");
    });
    socket.on("disconnect", () => {
      setConnected(false);
      setConnMsg("disconnected");
    });
    socket.on("connect_error", (err) => {
      setConnected(false);
      setConnMsg("connect error");
      console.error("socket connect_error", err);
    });

    socket.on("init", (history) => {
      if (Array.isArray(history) && history.length && bufferCtxRef.current) {
        for (const s of history) drawStrokeToBuffer(s);
        strokesRef.current = history.slice();
      } else {
        strokesRef.current = [];
      }
      needsRender.current = true;
    });

    socket.on("draw", (s) => {
      if (s) {
        drawStrokeToBuffer(s);
        strokesRef.current.push(s);
      }
      incomingQueue.current.push(null);
    });

    // animation loop
    let rafId = 0;
    const loop = () => {
      rafId = requestAnimationFrame(loop);
      paintFrame();
    };
    loop();

    return () => {
      cancelAnimationFrame(rafId);
      window.removeEventListener("resize", resize);
      canvas.removeEventListener("wheel", onWheel);
      canvas.removeEventListener("pointerdown", onPointerDown);
      canvas.removeEventListener("pointermove", onPointerMove);
      canvas.removeEventListener("pointerup", onPointerUp);
      canvas.removeEventListener("pointerleave", onPointerUp);
      canvas.removeEventListener("pointercancel", onPointerUp);
      socket.off("connect");
      socket.off("disconnect");
      socket.off("connect_error");
      socket.off("init");
      socket.off("draw");
    };
    // IMPORTANT: empty deps -> init once (prevents wipes on size/color change)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connected]); // keep 'connected' only if you want HUD to reflect conn state; can also be []

  /** Render a frame **/
  function paintFrame() {
    const ctx = ctxRef.current;
    const bcv = bufferCanvasRef.current;
    if (!ctx || !bcv) return;

    const canvas = ctx.canvas;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.fillStyle = "#0b0b10";
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    ctx.save();
    ctx.translate(canvas.clientWidth / 2, canvas.clientHeight / 2);
    ctx.scale(scaleRef.current, scaleRef.current);
    ctx.translate(offsetRef.current.x, offsetRef.current.y);

    // grid
    ctx.save();
    ctx.lineWidth = 1 / scaleRef.current;
    ctx.strokeStyle = "rgba(255,255,255,0.06)";
    const step = 200;
    for (let x = -WORLD_SIZE; x <= WORLD_SIZE; x += step) {
      ctx.beginPath();
      ctx.moveTo(x, -WORLD_SIZE);
      ctx.lineTo(x, WORLD_SIZE);
      ctx.stroke();
    }
    for (let y = -WORLD_SIZE; y <= WORLD_SIZE; y += step) {
      ctx.beginPath();
      ctx.moveTo(-WORLD_SIZE, y);
      ctx.lineTo(WORLD_SIZE, y);
      ctx.stroke();
    }
    ctx.restore();

    // blit buffer inside ball
    ctx.save();
    ctx.beginPath();
    ctx.arc(0, 0, BALL_RADIUS, 0, Math.PI * 2);
    ctx.clip();
    ctx.drawImage(bcv, -BUF_SIZE / 2, -BUF_SIZE / 2);
    ctx.restore();

    // border
    ctx.beginPath();
    ctx.arc(0, 0, BALL_RADIUS, 0, Math.PI * 2);
    ctx.lineWidth = 4 / scaleRef.current;
    ctx.strokeStyle = "#888";
    ctx.stroke();

    ctx.restore();

    // HUD ~10Hz
    if (!paintFrame._lastHud || performance.now() - paintFrame._lastHud > 100) {
      setHud({
        scale: scaleRef.current,
        offsetX: offsetRef.current.x,
        offsetY: offsetRef.current.y,
        strokes: strokesRef.current.length,
      });
      paintFrame._lastHud = performance.now();
    }

    if (incomingQueue.current.length) incomingQueue.current.length = 0;
  }

  return (
    <div className="app">
      <div className="toolbar">
        <span className="brand">🟢 Pump Ball</span>

        {/* Contract badge */}
        <div className="contract">
          <a
            className="badge"
            href={PUMPFUN_URL}
            target="_blank"
            rel="noopener noreferrer"
          >
            {CONTRACT_ADDRESS}
          </a>
          <button
            className="copy"
            onClick={() => {
              navigator.clipboard.writeText(CONTRACT_ADDRESS);
              showToast("Contract copied ✅");
            }}
          >
            Copy
          </button>
        </div>

        {/* Wallet section */}
        {walletAddr ? (
          <>
            <span className="wallet" title={rpcNote || "Wallet connected"}>
              {walletAddr.slice(0, 4)}…{walletAddr.slice(-4)}{" "}
              {checkingHoldings
                ? "(checking…)"
                : hasFullAccess
                ? "• Full"
                : `• Demo ${demoUsed}/${DEMO_LIMIT}`}
            </span>
            <button className="disconnect" onClick={disconnectWallet}>
              Disconnect
            </button>
          </>
        ) : (
          <button className="connect" onClick={connectWallet}>
            Connect Wallet
          </button>
        )}

        {/* Tools */}
        <label>
          Color
          <input
            type="color"
            value={color}
            onChange={(e) => setColor(e.target.value)}
          />
        </label>
        <label>
          Size
          <input
            type="range"
            min="1"
            max="40"
            value={size}
            onChange={(e) => setSize(parseInt(e.target.value, 10))}
          />
          <span className="size">{size}px</span>
        </label>

        <span className="hint">Left/Middle/Right or Shift = pan • Wheel = zoom</span>
        <span className="hud">
          scale {hud.scale.toFixed(2)} | ({hud.offsetX.toFixed(0)},{" "}
          {hud.offsetY.toFixed(0)}) | {hud.strokes} strokes
        </span>
        <span className={`conn ${connected ? "ok" : "err"}`}>ws: {connMsg}</span>
      </div>

      <canvas
        ref={canvasRef}
        style={{ display: "block", width: "100vw", height: "100vh" }}
      />

      {/* Toast UI */}
      <div className={`toast ${toast.show ? "show" : ""}`}>{toast.msg}</div>

      <style>{`
        :root { --bg: #0b0b10; --panel: #11131a; --text: #eaeaea; }
        * { box-sizing: border-box; }
        html, body, #root { height: 100%; margin: 0; background: var(--bg); }
        .toolbar {
          position: fixed; top: 12px; left: 12px; right: 12px;
          display: flex; align-items: center; gap: 14px; flex-wrap: wrap;
          background: rgba(17,19,26,0.8); backdrop-filter: blur(6px);
          padding: 10px 12px; border: 1px solid #22273a; border-radius: 12px; color: var(--text);
          font-family: ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto;
          z-index: 10;
        }
        .contract { display: inline-flex; align-items: center; gap: 8px; margin-right: 4px; }
        .badge {
          background: linear-gradient(90deg, #6a0dad, #00ff99);
          color: white; padding: 6px 12px; border-radius: 8px;
          font-weight: 700; font-size: 14px; text-decoration: none;
          font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace;
          border: 0.5px solid rgba(255,255,255,0.25);
          box-shadow: 0 0 10px rgba(0,0,0,0.25);
          white-space: nowrap; max-width: 42vw; overflow: hidden; text-overflow: ellipsis;
        }
        .copy { background: #fff; color: #6a0dad; border: none; padding: 6px 10px; border-radius: 6px; cursor: pointer; font-weight: 700; }
        .connect { background: #00ff99; color: #11131a; border: none; padding: 6px 10px; border-radius: 8px; cursor: pointer; font-weight: 800; }
        .disconnect { background: #22273a; color: #eaeaea; border: 1px solid #34405c; padding: 6px 10px; border-radius: 8px; cursor: pointer; font-weight: 700; }
        .wallet { font-size: 12px; opacity: 0.9; padding: 2px 8px; border: 1px solid #22273a; border-radius: 8px; }
        label { display: inline-flex; align-items: center; gap: 8px; }
        input[type="range"] { width: 120px; }
        .hint { opacity: 0.7; font-size: 12px; }
        .hud { opacity: 0.8; font-size: 12px; margin-left: auto; }
        .conn { padding: 4px 8px; border-radius: 10px; font-size: 12px; background: rgba(17,19,26,0.8); border: 1px solid #22273a; color: var(--text); }
        .conn.ok { outline: 1px solid #1db95440; }
        .conn.err { outline: 1px solid #ff4d4f40; }

        /* Toast styles */
        .toast {
          position: fixed; left: 50%; bottom: 20px; transform: translateX(-50%) translateY(20px);
          background: rgba(17,19,26,0.9);
          color: #fff; padding: 10px 14px; border-radius: 10px; border: 1px solid #22273a;
          font-size: 14px; opacity: 0; transition: opacity .2s ease, transform .2s ease;
          z-index: 50; pointer-events: none;
        }
        .toast.show { opacity: 1; transform: translateX(-50%) translateY(0); }

        @media (max-width: 640px) { .badge { max-width: 58vw; } }
      `}</style>
    </div>
  );
}
