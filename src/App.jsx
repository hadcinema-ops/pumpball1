import React, { useRef, useEffect, useState } from "react";
import { io } from "socket.io-client";

// Resolve backend URL
const BACKEND_URL = (typeof window !== "undefined" && window.PUMP_BACKEND_URL)
  || process.env.REACT_APP_BACKEND_URL
  || "";

const socket = io(BACKEND_URL, {
  transports: ["websocket"],
  withCredentials: false,
  reconnection: true,
  reconnectionAttempts: Infinity
});

function getInverseTransform(scale, offsetX, offsetY, canvas, dpr) {
  return (sx, sy) => {
    const rect = canvas.getBoundingClientRect();
    // screen -> CSS pixels -> world (account for DPR)
    const cssX = (sx - rect.left);
    const cssY = (sy - rect.top);
    const worldX = (cssX - canvas.clientWidth / 2) / scale - offsetX;
    const worldY = (cssY - canvas.clientHeight / 2) / scale - offsetY;
    return { x: worldX, y: worldY };
  };
}

export default function App() {
  const canvasRef = useRef(null);
  const [ctx, setCtx] = useState(null);

  // View
  const [scale, setScale] = useState(1);
  const [offset, setOffset] = useState({ x: 0, y: 0 });

  // Tools
  const [color, setColor] = useState("#111111");
  const [size, setSize] = useState(3);

  // Connection
  const [connected, setConnected] = useState(false);
  const [connMsg, setConnMsg] = useState("connecting…");

  // Interaction state
  const drawingRef = useRef(false);
  const panningRef = useRef(false);
  const lastPos = useRef({ x: 0, y: 0 });
  const panStart = useRef({ x: 0, y: 0 });
  const offsetStart = useRef({ x: 0, y: 0 });

  // DPR
  const dprRef = useRef(1);

  // Ball/world
  const BALL_RADIUS = 2000;
  const WORLD_SIZE = BALL_RADIUS * 2 + 200;
  const strokesRef = useRef([]);

  // Init canvas with DPR scaling
  useEffect(() => {
    const canvas = canvasRef.current;
    const context = canvas.getContext("2d");
    setCtx(context);

    const resize = () => {
      const dpr = Math.max(1, window.devicePixelRatio || 1);
      dprRef.current = dpr;
      // Set display size (CSS pixels)
      const cssW = window.innerWidth;
      const cssH = window.innerHeight;
      // Set actual canvas size in device pixels
      canvas.width = Math.floor(cssW * dpr);
      canvas.height = Math.floor(cssH * dpr);
      canvas.style.width = cssW + "px";
      canvas.style.height = cssH + "px";
      context.setTransform(dpr, 0, 0, dpr, 0, 0); // scale all drawing ops by DPR
      render(context);
    };
    window.addEventListener("resize", resize);
    resize();

    // Native wheel listener with passive:false so preventDefault works everywhere
    const onWheel = (e) => {
      e.preventDefault();
      const delta = -e.deltaY;
      const zoomIntensity = 0.0015;
      const newScale = Math.min(5, Math.max(0.2, scale * (1 + delta * zoomIntensity)));
      const inv = getInverseTransform(scale, offset.x, offset.y, canvas, dprRef.current);
      const before = inv(e.clientX, e.clientY);
      const invNew = getInverseTransform(newScale, offset.x, offset.y, canvas, dprRef.current);
      const after = invNew(e.clientX, e.clientY);
      const dx = after.x - before.x;
      const dy = after.y - before.y;
      setOffset((o) => ({ x: o.x + dx, y: o.y + dy }));
      setScale(newScale);
    };
    canvas.addEventListener("wheel", onWheel, { passive: false });

    // Pointer events (mouse/touch unified)
    const onPointerDown = (e) => {
      canvas.setPointerCapture?.(e.pointerId);
      if (e.button === 1 || e.button === 2 || e.shiftKey || e.altKey || e.metaKey || e.ctrlKey) {
        panningRef.current = true;
        panStart.current = { x: e.clientX, y: e.clientY };
        offsetStart.current = { ...offset };
        return;
      }
      drawingRef.current = true;
      const inv = getInverseTransform(scale, offset.x, offset.y, canvas, dprRef.current);
      lastPos.current = inv(e.clientX, e.clientY);
    };

    const onPointerMove = (e) => {
      if (panningRef.current) {
        const dx = (e.clientX - panStart.current.x) / scale;
        const dy = (e.clientY - panStart.current.y) / scale;
        setOffset({ x: offsetStart.current.x + dx, y: offsetStart.current.y + dy });
        return;
      }
      if (!drawingRef.current || !connected) return;
      const inv = getInverseTransform(scale, offset.x, offset.y, canvas, dprRef.current);
      const p = inv(e.clientX, e.clientY);
      const stroke = { x0: lastPos.current.x, y0: lastPos.current.y, x1: p.x, y1: p.y, color, size };
      strokesRef.current.push(stroke);
      drawStroke(context, stroke);
      socket.emit("draw", stroke);
      lastPos.current = p;
    };

    const endAll = () => { drawingRef.current = false; panningRef.current = false; };

    canvas.addEventListener("pointerdown", onPointerDown);
    canvas.addEventListener("pointermove", onPointerMove);
    canvas.addEventListener("pointerup", endAll);
    canvas.addEventListener("pointerleave", endAll);
    canvas.addEventListener("pointercancel", endAll);
    canvas.addEventListener("contextmenu", (e) => e.preventDefault());

    // Socket events
    socket.on("connect", () => { setConnected(true); setConnMsg("connected"); });
    socket.on("disconnect", () => { setConnected(false); setConnMsg("disconnected"); });
    socket.on("connect_error", (err) => { setConnected(false); setConnMsg("connect error"); console.error("socket connect_error", err); });

    socket.on("init", (history) => {
      strokesRef.current = history || [];
      render(context);
    });
    socket.on("draw", (stroke) => {
      strokesRef.current.push(stroke);
      drawStroke(context, stroke);
      drawHUD(context);
    });

    return () => {
      window.removeEventListener("resize", resize);
      canvas.removeEventListener("wheel", onWheel);
      canvas.removeEventListener("pointerdown", onPointerDown);
      canvas.removeEventListener("pointermove", onPointerMove);
      canvas.removeEventListener("pointerup", endAll);
      canvas.removeEventListener("pointerleave", endAll);
      canvas.removeEventListener("pointercancel", endAll);
      socket.off("connect"); socket.off("disconnect"); socket.off("connect_error");
      socket.off("init"); socket.off("draw");
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scale, offset, color, size, connected]);

  // Rendering helpers
  function applyView(context) {
    const c = context.canvas;
    context.save();
    // We already set DPR with setTransform; now apply view in CSS px space
    context.translate(c.clientWidth / 2, c.clientHeight / 2);
    context.scale(scale, scale);
    context.translate(offset.x, offset.y);
  }

  function drawBallMask(context) {
    context.save();
    context.beginPath();
    context.arc(0, 0, BALL_RADIUS, 0, Math.PI * 2);
    context.clip();
  }

  function drawBallBorder(context) {
    context.save();
    context.beginPath();
    context.arc(0, 0, BALL_RADIUS, 0, Math.PI * 2);
    context.lineWidth = 4 / scale;
    context.strokeStyle = "#888";
    context.stroke();
    context.restore();
  }

  function drawGrid(context) {
    const step = 200;
    context.save();
    context.lineWidth = 1 / scale;
    context.strokeStyle = "rgba(0,0,0,0.06)";
    for (let x = -WORLD_SIZE; x <= WORLD_SIZE; x += step) {
      context.beginPath();
      context.moveTo(x, -WORLD_SIZE);
      context.lineTo(x, WORLD_SIZE);
      context.stroke();
    }
    for (let y = -WORLD_SIZE; y <= WORLD_SIZE; y += step) {
      context.beginPath();
      context.moveTo(-WORLD_SIZE, y);
      context.lineTo(WORLD_SIZE, y);
      context.stroke();
    }
    context.restore();
  }

  function drawBackground(context) {
    const c = context.canvas;
    context.save();
    context.clearRect(0, 0, c.width, c.height);
    context.fillStyle = "#0b0b10";
    context.fillRect(0, 0, c.width, c.height);
    context.restore();
  }

  function drawStroke(context, s) {
    context.save();
    applyView(context);
    drawBallMask(context);

    context.beginPath();
    context.moveTo(s.x0, s.y0);
    context.lineTo(s.x1, s.y1);
    context.strokeStyle = s.color || "#111";
    context.lineWidth = (s.size || 3);
    context.lineCap = "round";
    context.lineJoin = "round";
    context.stroke();

    context.restore();
    drawBallBorder(context);
  }

  function render(context) {
    if (!context) return;
    drawBackground(context);

    applyView(context);
    drawGrid(context);

    // Fill ball
    context.save();
    context.beginPath();
    context.arc(0, 0, BALL_RADIUS, 0, Math.PI * 2);
    context.fillStyle = "#ffffff";
    context.fill();
    context.restore();

    // Strokes
    context.save();
    applyView(context);
    drawBallMask(context);
    for (const s of strokesRef.current) {
      context.beginPath();
      context.moveTo(s.x0, s.y0);
      context.lineTo(s.x1, s.y1);
      context.strokeStyle = s.color || "#111";
      context.lineWidth = (s.size || 3);
      context.lineCap = "round";
      context.lineJoin = "round";
      context.stroke();
    }
    context.restore();

    drawBallBorder(context);
    drawHUD(context);
  }

  function drawHUD(context) {
    context.save();
    // HUD in CSS pixels
    context.setTransform(1, 0, 0, 1, 0, 0);
    context.scale(dprRef.current, dprRef.current);
    const info = `scale ${scale.toFixed(2)} | offset (${offset.x.toFixed(0)}, ${offset.y.toFixed(0)}) | strokes ${strokesRef.current.length}`;
    context.font = "14px ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto";
    context.fillStyle = "#eaeaea";
    context.fillText(info, 12, 24);
    context.restore();
  }

  return (
    <div className="app">
      <div className="toolbar">
        <span className="brand">🟢 Pump Ball</span>
        <label>
          Color
          <input type="color" value={color} onChange={(e) => setColor(e.target.value)} />
        </label>
        <label>
          Size
          <input type="range" min="1" max="40" value={size} onChange={(e) => setSize(parseInt(e.target.value, 10))} />
          <span className="size">{size}px</span>
        </label>
        <span className="hint">Left/Middle/Right + Shift = pan • Wheel = zoom</span>
      </div>

      <canvas ref={canvasRef} style={{ display: "block", width: "100vw", height: "100vh", touchAction: "none", cursor: panningRef.current ? "grab" : "crosshair" }} />

      <style>{`
        :root { --bg: #0b0b10; --panel: #11131a; --text: #eaeaea; }
        * { box-sizing: border-box; }
        html, body, #root { height: 100%; margin: 0; background: var(--bg); }
        .toolbar {
          position: fixed; top: 12px; left: 12px; right: 12px;
          display: flex; align-items: center; gap: 14px;
          background: rgba(17,19,26,0.8); backdrop-filter: blur(6px);
          padding: 10px 12px; border: 1px solid #22273a; border-radius: 12px; color: var(--text);
          font-family: ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto;
          z-index: 10;
        }
        label { display: inline-flex; align-items: center; gap: 8px; }
        input[type="range"] { width: 120px; }
        .hint { margin-left: auto; opacity: 0.7; font-size: 12px; }
        .conn { position: fixed; top: 12px; right: 12px; padding: 6px 10px; border-radius: 10px; font-size: 12px;
          background: rgba(17,19,26,0.8); border: 1px solid #22273a; color: var(--text); z-index: 11; }
        .conn.ok { outline: 1px solid #1db95440; }
        .conn.err { outline: 1px solid #ff4d4f40; }
      `}</style>

      <div className={`conn ${connected ? "ok" : "err"}`}>ws: {connMsg}</div>
    </div>
  );
}
