(() => {
  const canvas = document.querySelector("#resourceChart");
  if (!canvas) return;
  const context = canvas.getContext("2d");
  const history = [];
  const limit = 60;

  function draw() {
    const bounds = canvas.getBoundingClientRect();
    if (!bounds.width || !bounds.height) return;
    const scale = window.devicePixelRatio || 1;
    canvas.width = Math.round(bounds.width * scale);
    canvas.height = Math.round(bounds.height * scale);
    context.setTransform(scale, 0, 0, scale, 0, 0);

    const width = bounds.width;
    const height = bounds.height;
    const padding = { top: 12, right: 14, bottom: 23, left: 38 };
    const graphWidth = width - padding.left - padding.right;
    const graphHeight = height - padding.top - padding.bottom;
    context.clearRect(0, 0, width, height);
    context.font = "11px system-ui, sans-serif";
    context.textBaseline = "middle";
    context.textAlign = "right";

    for (const level of [0, 50, 100]) {
      const y = padding.top + graphHeight * (1 - level / 100);
      context.strokeStyle = "#2a2a2e";
      context.lineWidth = 1;
      context.beginPath();
      context.moveTo(padding.left, y);
      context.lineTo(width - padding.right, y);
      context.stroke();
      context.fillStyle = "#77777e";
      context.fillText(`${level}%`, padding.left - 8, y);
    }

    if (history.length < 2) {
      context.textAlign = "center";
      context.fillStyle = "#85858d";
      context.fillText("수집된 데이터가 쌓이면 그래프가 표시됩니다.", width / 2, height / 2);
      return;
    }

    const series = [
      { key: "cpu", color: "#f1f1f2", dash: [] },
      { key: "memory", color: "#88888f", dash: [5, 4] }
    ];
    for (const line of series) {
      context.strokeStyle = line.color;
      context.lineWidth = 2;
      context.setLineDash(line.dash);
      context.beginPath();
      history.forEach((point, index) => {
        const x = padding.left + graphWidth * index / (limit - 1);
        const value = Math.max(0, Math.min(100, point[line.key]));
        const y = padding.top + graphHeight * (1 - value / 100);
        if (index === 0) context.moveTo(x, y);
        else context.lineTo(x, y);
      });
      context.stroke();
    }
    context.setLineDash([]);
  }

  window.updateResourceChart = (stats) => {
    history.push({
      cpu: Number(stats.cpu?.usagePercent) || 0,
      memory: Number(stats.memory?.usagePercent) || 0
    });
    if (history.length > limit) history.shift();
    draw();
  };

  window.addEventListener("resize", draw);
})();
