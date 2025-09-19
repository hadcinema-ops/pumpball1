import React, { useRef, useEffect, useState } from "react";
import { io } from "socket.io-client";

const socket = io(process.env.REACT_APP_BACKEND_URL || "http://localhost:4000", {
  transports: ["websocket"]
});

// Utility: screen -> world and world -> screen
function getInverseTransform(scale, offsetX, offsetY) {
  return (sx, sy, canvas) => {
    const rect = canvas.getBoundingClientRect();
    const x = (sx - rect.left - canvas.width / 2) / scale - offsetX;
    const y = (sy - rect.top - canvas.height / 2) / scale - offsetY;
    return { x, y };
  };
}

export default function App() {
  const canvasRef = useRef(null);
  const [ctx, setCtx] = useState(null);

  // View transform
  const [scale, setScale] = useState(1);
  const [offset, setOffset] = useState({ x: 0, y: 0 });

  // Tools
  const [color, setColor] = useState("#111111");
  const [size, setSize] = useState(3);

  // Interaction state
  const [isDrawing, setIsDrawing] = useState(false);
  const [isPanning, setIsPanning] = useState(false);
  const lastPos = useRef({ x: 0, y: 0 });
  const panStart = useRef({ x: 0, y: 0 });
  const offsetStart = useRef({ x: 0, y: 0 });

  // Ball size (world units)
  const BALL_RADIUS = 2000; // world units, large canvas
  const WORLD_SIZE = BALL_RADIUS * 2 + 200; // padding

  // Keep a local list of strokes to redraw on transform changes
  const strokesRef = useRef([]);

  // Initialize canvas
  useEffect(() => {
    const canvas = canvasRef.current;
    const context = canvas.getContext("2d");
    setCtx(context);

    const resize = () => {
      canvas.width = window.innerWidth;
      canvas.height = window.innerHeight;
      render(context);
    };
    window.addEventListener("resize", resize);
    resize();

    // Receive history and live strokes
    socket.on("init", (history) => {
      strokesRef.current = history;
      render(context);
    });
    socket.on("draw", (stroke) => {
      strokesRef.current.push(stroke);
      drawStroke(context, stroke);
      drawHUD(context);
    });

    return () => {
      window.removeEventListener("resize", resize);
      socket.off("init");
      socket.off("draw");
    };
  }, []);

  // Redraw when transform changes
  useEffect(() => {
    if (ctx) render(ctx);
  }, [scale, offset]);

  function clearCanvas(context) {
    const c = context.canvas;
    context.clearRect(0, 0, c.width, c.height);
  }

  function applyView(context) {
    const c = context.canvas;
    context.save();
    context.translate(c.width / 2, c.height / 2);
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
    // subtle bg
    const c = context.canvas;
    context.save();
    context.fillStyle = "#fafafa";
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
    clearCanvas(context);
    drawBackground(context);

    applyView(context);
    drawGrid(context);

    // Mask and fill ball
    context.save();
    context.beginPath();
    context.arc(0, 0, BALL_RADIUS, 0, Math.PI * 2);
    context.fillStyle = "#ffffff";
    context.fill();
    context.restore();

    // Draw all strokes
    context.save();
    applyView(context);
    drawBallMask(context);
    for (const s of strokesRef.current) drawStroke(context, s);
    context.restore();

    drawBallBorder(context);
    drawHUD(context);
  }

  function drawHUD(context) {
    // Simple HUD – top-left
    context.save();
    context.resetTransform?.();
    // Fallback for browsers without resetTransform
    const c = context.canvas;
    context.clearRect(0, 0, 0, 0);
    context.font = "14px ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto";
    context.fillStyle = "#222";
    const info = `scale ${scale.toFixed(2)} | offset (${offset.x.toFixed(0)}, ${offset.y.toFixed(0)}) | strokes ${strokesRef.current.length}`;
    context.fillText(info, 12, 24);
    context.restore();
  }

  // Mouse / touch handlers
  const onWheel = (e) => {
    e.preventDefault();
    const delta = -e.deltaY;
    const zoomIntensity = 0.0015;
    const newScale = Math.min(5, Math.max(0.2, scale * (1 + delta * zoomIntensity)));

    // Zoom to cursor
    const inv = getInverseTransform(scale, offset.x, offset.y);
    const worldBefore = inv(e.clientX, e.clientY, canvasRef.current);
    const invNew = getInverseTransform(newScale, offset.x, offset.y);
    const worldAfter = invNew(e.clientX, e.clientY, canvasRef.current);
    const dx = worldAfter.x - worldBefore.x;
    const dy = worldAfter.y - worldBefore.y;

    setOffset({ x: offset.x + dx, y: offset.y + dy });
    setScale(newScale);
  };

  const onMouseDown = (e) => {
    if (e.button === 1 || e.button === 2 || e.shiftKey || e.altKey || e.metaKey || e.ctrlKey) {
      // Pan mode with right/middle click or modifier
      setIsPanning(true);
      panStart.current = { x: e.clientX, y: e.clientY };
      offsetStart.current = { ...offset };
      return;
    }
    // Draw
    setIsDrawing(true);
    const inv = getInverseTransform(scale, offset.x, offset.y);
    const p = inv(e.clientX, e.clientY, canvasRef.current);
    lastPos.current = p;
  };

  const onMouseMove = (e) => {
    if (isPanning) {
      const dx = (e.clientX - panStart.current.x) / scale;
      const dy = (e.clientY - panStart.current.y) / scale;
      setOffset({ x: offsetStart.current.x + dx, y: offsetStart.current.y + dy });
      return;
    }
    if (!isDrawing) return;
    const inv = getInverseTransform(scale, offset.x, offset.y);
    const p = inv(e.clientX, e.clientY, canvasRef.current);
    const stroke = { x0: lastPos.current.x, y0: lastPos.current.y, x1: p.x, y1: p.y, color, size };
    strokesRef.current.push(stroke);
    drawStroke(ctx, stroke);
    socket.emit("draw", stroke);
    lastPos.current = p;
  };

  const endStroke = () => {
    setIsDrawing(false);
    setIsPanning(false);
  };

  // Touch support
  const onTouchStart = (e) => {
    if (e.touches.length === 2) {
      setIsPanning(true);
      panStart.current = { x: e.touches[0].clientX, y: e.touches[0].clientY };
      offsetStart.current = { ...offset };
      return;
    }
    setIsDrawing(true);
    const inv = getInverseTransform(scale, offset.x, offset.y);
    const p = inv(e.touches[0].clientX, e.touches[0].clientY, canvasRef.current);
    lastPos.current = p;
  };

  const onTouchMove = (e) => {
    if (isPanning) {
      const dx = (e.touches[0].clientX - panStart.current.x) / scale;
      const dy = (e.touches[0].clientY - panStart.current.y) / scale;
      setOffset({ x: offsetStart.current.x + dx, y: offsetStart.current.y + dy });
      return;
    }
    if (!isDrawing) return;
    const inv = getInverseTransform(scale, offset.x, offset.y);
    const p = inv(e.touches[0].clientX, e.touches[0].clientY, canvasRef.current);
    const stroke = { x0: lastPos.current.x, y0: lastPos.current.y, x1: p.x, y1: p.y, color, size };
    strokesRef.current.push(stroke);
    drawStroke(ctx, stroke);
    socket.emit("draw", stroke);
    lastPos.current = p;
  };

  const onTouchEnd = () => endStroke();

  return (
    <div className="app">
      <div className="toolbar">
        <span className="brand">🟢 Pump Ball</span>
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
        <span className="hint">Left‑click: draw • Right‑click/Shift: pan • Wheel: zoom</span>
      </div>

      <canvas
        ref={canvasRef}
        onContextMenu={(e) => e.preventDefault()}
        onWheel={onWheel}
        onMouseDown={onMouseDown}
        onMouseMove={onMouseMove}
        onMouseUp={endStroke}
        onMouseLeave={endStroke}
        onTouchStart={onTouchStart}
        onTouchMove={onTouchMove}
        onTouchEnd={onTouchEnd}
        style={{ display: "block", width: "100vw", height: "100vh", cursor: isPanning ? "grab" : "crosshair" }}
      />

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
        }
        .brand { font-weight: 700; letter-spacing: 0.2px; }
        label { display: inline-flex; align-items: center; gap: 8px; }
        input[type="range"] { width: 120px; }
        .hint { margin-left: auto; opacity: 0.7; font-size: 12px; }
      `}</style>
    </div>
  );
}
