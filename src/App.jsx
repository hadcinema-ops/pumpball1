import React, { useRef, useEffect, useState } from "react";
import { io } from "socket.io-client";

/** --- Pump.fun Contract (hard-coded) --- */
const CONTRACT_ADDRESS = "PASTE_YOUR_PUMPFUN_MINT";
const PUMPFUN_URL = `https://pump.fun/coin/${CONTRACT_ADDRESS}`;

/** Backend URL resolution **/
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

  // view kept in refs to avoid frequent React rerenders during pan/zoom
  const scaleRef = useRef(1);
  const offsetRef = useRef({ x: 0, y: 0 });

  // HUD state (lightweight)
  const [hud, setHud] = useState({ scale: 1, offsetX: 0, offsetY: 0, strokes: 0 });
  const [connected, setConnected] = useState(false);
  const [connMsg, setConnMsg] = useState("connecting…");

  // tool state
  const [color, setColor] = useState("#111111");
  const [size, setSize] = useState(3);

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
  const strokesRef = useRef([]);

  // a queue of incoming strokes from socket to draw in the next frame
  const incomingQueue = useRef([]);
  const needsRender = useRef(true);

  // helper: screen -> world
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

  /** Setup once **/
  useEffect(() => {
    const canvas = canvasRef.current;
    const ctx = canvas.getContext("2d");
    ctxRef.current = ctx;

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

    // wheel (non-passive)
    const onWheel = (e) => {
      e.preventDefault();
      const delta = -e.deltaY;
      const zoomIntensity = 0.0015;
      const s0 = scaleRef.current;
      const s1 = Math.min(5, Math.max(0.2, s0 * (1 + delta * zoomIntensity)));
      const before = toWorld(e.clientX, e.clientY);
      scaleRef.current = s1;
      const after = toWorld(e.clientX, e.clientY);
      // maintain cursor focus
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
      drawingRef.current = true;
      lastPos.current = toWorld(e.clientX, e.clientY);
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

      const now = performance.now();
      const p = toWorld(e.clientX, e.clientY);
      // sample: only draw/emit if moved enough or > 12ms passed
      if (dist(p, lastPos.current) < 1 && now - lastEmit.current < 12) return;

      const stroke = {
        x0: lastPos.current.x,
        y0: lastPos.current.y,
        x1: p.x,
        y1: p.y,
        color,
        size,
      };
      strokesRef.current.push(stroke);
      incomingQueue.current.push(stroke); // draw this frame
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
      strokesRef.current = Array.isArray(history) ? history : [];
      needsRender.current = true;
      // HUD update soon
    });
    socket.on("draw", (s) => {
      strokesRef.current.push(s);
      incomingQueue.current.push(s);
    });

    // animation loop (single rAF loop)
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
    // eslint-disable-next-line
  }, [connected, color, size]);

  /** Render a frame **/
  function paintFrame() {
    const ctx = ctxRef.current;
    if (!ctx) return;
    const canvas = ctx.canvas;

    // only full-render if needed (pan/zoom/init)
    if (needsRender.current) {
      // background
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      ctx.fillStyle = "#0b0b10";
      ctx.fillRect(0, 0, canvas.width, canvas.height);

      // apply view
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

      // ball fill
      ctx.save();
      ctx.beginPath();
      ctx.arc(0, 0, BALL_RADIUS, 0, Math.PI * 2);
      ctx.fillStyle = "#ffffff";
      ctx.fill();
      ctx.clip();

      // draw ALL strokes (full render)
      ctx.lineCap = "round";
      ctx.lineJoin = "round";
      for (const s of strokesRef.current) {
        ctx.beginPath();
        ctx.moveTo(s.x0, s.y0);
        ctx.lineTo(s.x1, s.y1);
        ctx.strokeStyle = s.color || "#111";
        ctx.lineWidth = s.size || 3;
        ctx.stroke();
      }
      ctx.restore(); // remove clip

      // ball border (draw ONCE per full render — prevents ring artifacts)
      ctx.beginPath();
      ctx.arc(0, 0, BALL_RADIUS, 0, Math.PI * 2);
      ctx.lineWidth = 4 / scaleRef.current;
      ctx.strokeStyle = "#888";
      ctx.stroke();

      ctx.restore(); // end view

      needsRender.current = false;
    }

    // incremental strokes (fast path): draw only new strokes since last frame
    if (incomingQueue.current.length) {
      const sscale = scaleRef.current;

      ctx.save();
      ctx.translate(canvas.clientWidth / 2, canvas.clientHeight / 2);
      ctx.scale(sscale, sscale);
      ctx.translate(offsetRef.current.x, offsetRef.current.y);

      // clip to ball
      ctx.save();
      ctx.beginPath();
      ctx.arc(0, 0, BALL_RADIUS, 0, Math.PI * 2);
      ctx.clip();

      ctx.lineCap = "round";
      ctx.lineJoin = "round";

      let s;
      while ((s = incomingQueue.current.shift())) {
        ctx.beginPath();
        ctx.moveTo(s.x0, s.y0);
        ctx.lineTo(s.x1, s.y1);
        ctx.strokeStyle = s.color || "#111";
        ctx.lineWidth = s.size || 3;
        ctx.stroke();
      }
      ctx.restore(); // remove clip

      // redraw border just once (thin)
      ctx.beginPath();
      ctx.arc(0, 0, BALL_RADIUS, 0, Math.PI * 2);
      ctx.lineWidth = 4 / sscale;
      ctx.strokeStyle = "#888";
      ctx.stroke();

      ctx.restore();
    }

    // update HUD at ~10Hz
    if (!paintFrame._lastHud || performance.now() - paintFrame._lastHud > 100) {
      setHud({
        scale: scaleRef.current,
        offsetX: offsetRef.current.x,
        offsetY: offsetRef.current.y,
        strokes: strokesRef.current.length,
      });
      paintFrame._lastHud = performance.now();
    }
  }

  return (
    <div className="app">
      <div className="toolbar">
        <span className="brand">🟢 Pump Ball</span>

        {/* Pump.fun contract badge + copy */}
        <div className="contract">
          <a
            className="badge"
            href={PUMPFUN_URL}
            target="_blank"
            rel="noopener noreferrer"
            title="Open on Pump.fun"
          >
            {CONTRACT_ADDRESS}
          </a>
          <button
            className="copy"
            onClick={() => {
              navigator.clipboard.writeText(CONTRACT_ADDRESS);
              alert("Contract address copied!");
            }}
            title="Copy contract address"
          >
            Copy
          </button>
        </div>

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
        <span className="hint">
          Left/Middle/Right or Shift = pan • Wheel = zoom
        </span>
        <span className="hud">
          scale {hud.scale.toFixed(2)} | ({hud.offsetX.toFixed(0)},{" "}
          {hud.offsetY.toFixed(0)}) | {hud.strokes} strokes
        </span>
        <span className={`conn ${connected ? "ok" : "err"}`}>
          ws: {connMsg}
        </span>
      </div>

      <canvas
        ref={canvasRef}
        style={{ display: "block", width: "100vw", height: "100vh" }}
      />

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
        .contract {
          display: inline-flex; align-items: center; gap: 8px;
          margin-right: 4px;
        }
        .badge {
          background: linear-gradient(90deg, #6a0dad, #00ff99);
          color: white; padding: 6px 12px; border-radius: 8px;
          font-weight: 700; font-size: 14px; text-decoration: none;
          font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace;
          border: 0.5px solid rgba(255,255,255,0.25);
          box-shadow: 0 0 10px rgba(0,0,0,0.25);
          white-space: nowrap; max-width: 42vw; overflow: hidden; text-overflow: ellipsis;
        }
        .copy {
          background: #fff; color: #6a0dad; border: none;
          padding: 6px 10px; border-radius: 6px; cursor: pointer; font-weight: 700;
        }
        label { display: inline-flex; align-items: center; gap: 8px; }
        input[type="range"] { width: 120px; }
        .hint { opacity: 0.7; font-size: 12px; }
        .hud { opacity: 0.8; font-size: 12px; margin-left: auto; }
        .conn { padding: 4px 8px; border-radius: 10px; font-size: 12px;
          background: rgba(17,19,26,0.8); border: 1px solid #22273a; color: var(--text); }
        .conn.ok { outline: 1px solid #1db95440; }
        .conn.err { outline: 1px solid #ff4d4f40; }
        @media (max-width: 640px) {
          .badge { max-width: 58vw; }
        }
      `}</style>
    </div>
  );
}
