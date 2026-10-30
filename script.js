const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

// Footer year
document.querySelectorAll('.year').forEach(el => {
    el.textContent = new Date().getFullYear();
});

// Mobile menu
const navToggle = document.querySelector('.nav-toggle');
const nav = document.querySelector('.site-nav');
navToggle.addEventListener('click', () => {
    const open = nav.classList.toggle('open');
    navToggle.setAttribute('aria-expanded', open);
});

// Header gets a shadow once the page is scrolled
const header = document.querySelector('.site-header');
const onScroll = () => header.classList.toggle('scrolled', window.scrollY > 4);
window.addEventListener('scroll', onScroll, { passive: true });
onScroll();

// Fade content in as it scrolls into view
if (!reduceMotion && 'IntersectionObserver' in window) {
    const items = document.querySelectorAll(
        '.page-title, .page-intro, main h2, .topic, .pub, .person, .resource, .card, .news li, .contact'
    );
    const observer = new IntersectionObserver(entries => {
        entries.forEach(entry => {
            if (!entry.isIntersecting) return;
            const el = entry.target;
            el.classList.add('visible');
            observer.unobserve(el);
            // Hand control back to the element's own hover transitions
            el.addEventListener('transitionend', function done(e) {
                if (e.target !== el) return;   // ignore transitions bubbling up from children
                el.removeEventListener('transitionend', done);
                el.classList.remove('reveal', 'visible');
                el.style.transitionDelay = '';
            });
        });
    }, { threshold: 0.1 });

    items.forEach(el => {
        const index = [...el.parentElement.children].indexOf(el);
        el.style.transitionDelay = (index % 4) * 80 + 'ms';   // stagger items in a grid
        el.classList.add('reveal');
        observer.observe(el);
    });
}

// Home hero: robot teams cooperating over a faint field map: ground rovers in the crop
// rows below the text (on wide screens two teams: a crop field and an orchard) and a drone
// team over the terrain beside the text.
// Each team moves in a V formation behind its leader, shares messages over comm links, and works through field
// tasks (crops and trees in the crop rows, water and trees in the terrain area); nearby
// teams link up. Leaders show AI touches: a sensing cone that "detects" the task with
// corner brackets, and a fan of sampled candidate trajectories (MPPI-style) with the best
// one highlighted. Everything stays in the free space beside/below the text.
const canvas = document.querySelector('.hero-sim');
if (canvas) {
    const ctx = canvas.getContext('2d');
    // one colour for the whole scene, kept faint so it reads as a background texture
    const INK = getComputedStyle(document.documentElement).getPropertyValue('--accent').trim();
    const GRID = 40;           // px between grid lines
    const MARGIN = 36;         // px of clearance kept around the text
    const TRAIL = 36;          // trail points kept per rover
    const SLOTS = [[-24, -20], [-24, 20]];   // follower positions behind the leader (leader frame)
    const TASK_PAUSE = 45;     // frames a team stays at a finished task
    const MSG_EVERY = 110;     // frames between leader -> follower messages
    const FOV = 0.55;          // rad: half-angle of the leader's sensing cone
    const SENSE = 56;          // px: sensing cone radius
    const DETECT = 120;        // px: a task in view within this range gets a detection box
    const ROLLOUTS = 7;        // sampled candidate trajectories per leader
    let teams = [];
    let rovers = [];
    let pulses = [];           // expanding rings where a task was completed
    let packets = [];          // messages travelling along comm links
    let done = [];             // faint marks left at finished tasks
    let band = null;           // free band below the text
    let side = null;           // free area right of the text (null if too narrow)
    let gridLayer = null;
    let width = 0;
    let height = 0;
    let tick = 0;
    let running = false;

    const rand = (a, b) => a + Math.random() * (b - a);
    const wrap = (a) => Math.atan2(Math.sin(a), Math.cos(a));

    // Area covered by the hero text, relative to the canvas
    function textZone() {
        const c = canvas.getBoundingClientRect();
        let right = 0;
        let bottom = 0;
        canvas.parentElement.querySelectorAll('h1, p').forEach((el) => {
            const r = el.getBoundingClientRect();
            right = Math.max(right, r.right - c.left);
            bottom = Math.max(bottom, r.bottom - c.top);
        });
        return { right, bottom };
    }

    // Move a point out of the text block (and inside the canvas)
    function clearOfText(p) {
        let { x, y } = p;
        if (y < band.y0 && (!side || x < side.x0)) {
            if (side && side.x0 - x < band.y0 - y) x = side.x0;
            else y = band.y0;
        }
        return { x: Math.min(width - 12, Math.max(12, x)), y: Math.min(height - 12, Math.max(12, y)) };
    }

    // A point well inside a rectangle
    function randomPoint(r, inset) {
        const iy = Math.min(inset, (r.y1 - r.y0) / 2 - 1);
        return { x: rand(r.x0 + inset, r.x1 - inset), y: rand(r.y0 + iy, r.y1 - iy) };
    }

    // Each team works its own zone, so teams never cross: the field team tends crops and
    // fruit trees in the band below the text, the terrain team samples water and trees beside it.
    // Zones are rectangles, so a straight route to the next task always stays inside.
    const pick = (list) => list[Math.floor(Math.random() * list.length)];
    function newRoute(team) {
        const task = randomPoint(team.zone, 34);
        task.type = pick({ field: ['crop', 'crop', 'tree'], orchard: ['tree', 'tree', 'crop'], terrain: ['water', 'tree'] }[team.zone.kind]);
        return [task];
    }

    // Static background: map grid, crop rows in the band, terrain contours beside the text
    function drawBackground(dpr) {
        gridLayer = document.createElement('canvas');
        gridLayer.width = width * dpr;
        gridLayer.height = height * dpr;
        const g = gridLayer.getContext('2d');
        g.setTransform(dpr, 0, 0, dpr, 0, 0);
        g.strokeStyle = g.fillStyle = INK;
        g.lineWidth = 1;
        // crop rows: lines of small seedling dots
        for (let y = band.y0 + 10; y < band.y1; y += 20) {
            for (let x = band.x0 + 10; x < band.x1 - 10; x += 9) {
                g.globalAlpha = 0.09 + 0.04 * Math.sin(x * 0.05 + y);
                g.beginPath();
                g.arc(x, y, 1.4, 0, Math.PI * 2);
                g.fill();
            }
        }
        // terrain contours: a few wobbly closed loops
        if (side) {
            const cx = (side.x0 + side.x1) / 2;
            const cy = (side.y0 + side.y1) / 2;
            const R = Math.min(side.x1 - side.x0, side.y1 - side.y0) / 2;
            g.save();
            g.beginPath();
            g.rect(side.x0 - 20, side.y0, side.x1 - side.x0 + 20, side.y1 - side.y0);
            g.clip();
            for (let k = 1; k <= 5; k++) {
                g.globalAlpha = 0.07;
                g.beginPath();
                for (let a = 0; a <= Math.PI * 2 + 0.01; a += 0.05) {
                    const r = R * (k / 5) * (1 + 0.12 * Math.sin(3 * a + k) + 0.06 * Math.sin(5 * a - k));
                    const x = cx + r * 1.25 * Math.cos(a);
                    const y = cy + r * 0.85 * Math.sin(a);
                    if (a === 0) g.moveTo(x, y); else g.lineTo(x, y);
                }
                g.stroke();
            }
            g.restore();
        }
        for (let x = 0; x <= width; x += GRID) {
            g.globalAlpha = x % (GRID * 5) === 0 ? 0.09 : 0.045;
            g.beginPath(); g.moveTo(x, 0); g.lineTo(x, height); g.stroke();
        }
        for (let y = 0; y <= height; y += GRID) {
            g.globalAlpha = y % (GRID * 5) === 0 ? 0.09 : 0.045;
            g.beginPath(); g.moveTo(0, y); g.lineTo(width, y); g.stroke();
        }
    }

    function slotOf(team, i) {
        const L = team.leader;
        const [ox, oy] = SLOTS[i];
        const c = Math.cos(L.theta);
        const s = Math.sin(L.theta);
        return clearOfText({ x: L.x + ox * c - oy * s, y: L.y + ox * s + oy * c });
    }

    function resize() {
        const dpr = window.devicePixelRatio || 1;
        width = canvas.clientWidth;
        height = canvas.clientHeight;
        canvas.width = width * dpr;
        canvas.height = height * dpr;
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

        const zone = textZone();
        band = { x0: 20, x1: width - 20, y0: zone.bottom + MARGIN, y1: height - 16 };
        side = { x0: zone.right + MARGIN, x1: width - 20, y0: 20, y1: band.y0 };
        if (side.x1 - side.x0 < 160) side = null;             // phones: text spans the full width
        // team zones, with buffer strips between them so formations never overlap;
        // on wide screens the band splits into a crop field (left) and an orchard (right)
        const zones = [];
        if (side) {
            const split = band.x0 + (band.x1 - band.x0) * 0.58;
            zones.push({ kind: 'field', x0: band.x0, x1: split - 14, y0: band.y0 + 12, y1: band.y1 });
            zones.push({ kind: 'orchard', x0: split + 14, x1: band.x1, y0: band.y0 + 12, y1: band.y1 });
            zones.push({ kind: 'terrain', x0: side.x0, x1: side.x1, y0: side.y0, y1: side.y1 - 24 });
        } else {
            zones.push({ kind: 'field', x0: band.x0, x1: band.x1, y0: band.y0 + 12, y1: band.y1 });
        }
        drawBackground(dpr);

        pulses = [];
        packets = [];
        done = [];
        teams = zones.map((zone, k) => {
            const p = randomPoint(zone, 34);
            const air = zone.kind === 'terrain';                 // the terrain team is a drone team
            const leader = { x: p.x, y: p.y, theta: rand(0, Math.PI * 2), speed: air ? 0.9 : 0.75, trail: [] };
            const team = { zone, air, leader, followers: [], route: [], wait: 0, msgClock: k * 37 };
            team.route = newRoute(team);
            team.followers = SLOTS.map((_, i) => {
                const s = slotOf(team, i);
                return { x: s.x, y: s.y, theta: leader.theta, trail: [] };
            });
            return team;
        });
        rovers = teams.flatMap((t) => [t.leader, ...t.followers]);
    }

    function drive(r, target, maxV, turn) {
        const err = wrap(Math.atan2(target.y - r.y, target.x - r.x) - r.theta);
        r.theta += Math.max(-turn, Math.min(turn, err));
        const v = maxV * (0.4 + 0.6 * Math.max(0, Math.cos(err)));   // slow down for sharp turns
        r.x += v * Math.cos(r.theta);
        r.y += v * Math.sin(r.theta);
    }

    function step() {
        tick++;
        for (const team of teams) {
            const L = team.leader;
            if (team.wait > 0) {
                team.rollouts = null;
                team.wait--;
                if (team.wait === 0) team.route = newRoute(team);
            } else {
                const target = team.route[0];
                if (Math.hypot(target.x - L.x, target.y - L.y) < 8) {
                    team.route.shift();
                    if (!team.route.length) {                    // task done: pause and pulse
                        pulses.push({ x: target.x, y: target.y, age: 0 });
                        done.push({ x: target.x, y: target.y, type: target.type });
                        if (done.length > 10) done.shift();
                        team.wait = TASK_PAUSE;
                        team.route = [target];
                    }
                } else {
                    drive(L, target, L.speed, team.air ? 0.05 : 0.035);   // drones turn more nimbly
                    if (tick % 6 === 0) team.rollouts = sampleRollouts(L, target);
                }
            }
            // followers hold their V-formation slots
            team.followers.forEach((f, i) => {
                const s = slotOf(team, i);
                const d = Math.hypot(s.x - f.x, s.y - f.y);
                if (d > 1.5) drive(f, s, Math.min(1.5, 0.08 * d + 0.2), 0.09);
                else f.theta += 0.15 * wrap(L.theta - f.theta);     // settle into the leader's heading
            });
            // leader -> followers messages
            if (++team.msgClock % MSG_EVERY === 0) {
                for (const f of team.followers) packets.push({ from: L, to: f, t: 0 });
            }
        }
        for (const r of rovers) {
            if (tick % 3 === 0) {
                r.trail.push({ x: r.x, y: r.y });
                if (r.trail.length > TRAIL) r.trail.shift();
            }
        }
        pulses = pulses.filter((p) => ++p.age < 60);
        packets = packets.filter((p) => (p.t += 0.035) < 1);
    }

    function line(x1, y1, x2, y2, alpha) {
        ctx.globalAlpha = alpha;
        ctx.beginPath();
        ctx.moveTo(x1, y1);
        ctx.lineTo(x2, y2);
        ctx.stroke();
    }

    function dot(x, y, r, alpha, color = INK) {
        ctx.globalAlpha = alpha;
        ctx.fillStyle = color;
        ctx.beginPath();
        ctx.arc(x, y, r, 0, Math.PI * 2);
        ctx.fill();
    }

    // AI planning: sample a fan of short constant-turn trajectories (MPPI-style) and mark
    // the one that ends closest to the target
    function sampleRollouts(r, target) {
        const err = wrap(Math.atan2(target.y - r.y, target.x - r.x) - r.theta);
        const base = Math.max(-0.05, Math.min(0.05, err * 0.06));
        const paths = [];
        let best = 0;
        let bestCost = Infinity;
        for (let k = 0; k < ROLLOUTS; k++) {
            const w = base + (k - (ROLLOUTS - 1) / 2) * 0.012 + rand(-0.003, 0.003);
            let x = r.x;
            let y = r.y;
            let th = r.theta;
            const path = [];
            for (let s = 0; s < 16; s++) {
                th += w;
                x += 3 * Math.cos(th);
                y += 3 * Math.sin(th);
                path.push({ x, y });
            }
            const cost = Math.hypot(target.x - x, target.y - y);
            if (cost < bestCost) { bestCost = cost; best = k; }
            paths.push(path);
        }
        return { paths, best };
    }

    // AI perception: is the task close enough to recognise, and in view? (drones look straight down)
    function detected(L, task, air) {
        const d = Math.hypot(task.x - L.x, task.y - L.y);
        if (air) return d < DETECT * 0.8;
        const off = Math.abs(wrap(Math.atan2(task.y - L.y, task.x - L.x) - L.theta));
        return d < DETECT && off < FOV + 0.15;
    }

    // object-detection style corner brackets around a task
    function drawDetection(t, alpha) {
        const s = 13;      // half size
        const c = 5;       // corner length
        ctx.globalAlpha = alpha;
        ctx.strokeStyle = INK;
        ctx.lineWidth = 1.3;
        ctx.beginPath();
        for (const [sx, sy] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) {
            const x = t.x + sx * s;
            const y = t.y - 1 + sy * s;
            ctx.moveTo(x, y - sy * c); ctx.lineTo(x, y); ctx.lineTo(x - sx * c, y);
        }
        ctx.stroke();
        ctx.lineWidth = 1;
    }

    // Field task icons: a crop seedling, a fruit tree, or a water droplet
    function drawTask(t, alpha) {
        ctx.save();
        ctx.translate(t.x, t.y);
        ctx.globalAlpha = alpha;
        ctx.fillStyle = ctx.strokeStyle = INK;
        ctx.lineWidth = 1.4;
        ctx.lineCap = 'round';
        ctx.beginPath();
        if (t.type === 'crop') {
            ctx.moveTo(0, 6); ctx.lineTo(0, -1); ctx.stroke();                         // stem
            ctx.beginPath();
            ctx.moveTo(0, 0); ctx.quadraticCurveTo(-7, -2, -7, -8); ctx.quadraticCurveTo(-1, -6, 0, 0);
            ctx.moveTo(0, -1); ctx.quadraticCurveTo(6, -3, 6, -9); ctx.quadraticCurveTo(1, -7, 0, -1);
            ctx.fill();
        } else if (t.type === 'tree') {
            ctx.fillRect(-1, 0, 2, 7);                                                  // trunk
            ctx.beginPath();
            ctx.arc(0, -4, 6, 0, Math.PI * 2);                                          // canopy
            ctx.fill();
        } else {
            ctx.moveTo(0, -8);                                                          // droplet
            ctx.bezierCurveTo(6, -1, 5, 5, 0, 5);
            ctx.bezierCurveTo(-5, 5, -6, -1, 0, -8);
            ctx.fill();
        }
        ctx.restore();
    }

    // top view of a small quadcopter: X-frame, body, four rotors with spinning blades
    function drawDrone(r, leader) {
        ctx.save();
        ctx.translate(r.x, r.y);
        ctx.rotate(r.theta + Math.PI / 4);
        ctx.strokeStyle = ctx.fillStyle = INK;
        ctx.globalAlpha = leader ? 0.65 : 0.5;
        ctx.lineWidth = 1.8;
        ctx.beginPath();
        ctx.moveTo(-6, -6); ctx.lineTo(6, 6);
        ctx.moveTo(6, -6); ctx.lineTo(-6, 6);
        ctx.stroke();
        ctx.fillRect(-2.5, -2.5, 5, 5);                     // body
        ctx.lineWidth = 1;
        const spin = tick * 0.5;
        for (const [px, py] of [[-6, -6], [6, -6], [6, 6], [-6, 6]]) {
            ctx.globalAlpha = 0.35;
            ctx.beginPath();
            ctx.arc(px, py, 3.4, 0, Math.PI * 2);           // rotor guard
            ctx.stroke();
            ctx.globalAlpha = 0.55;
            ctx.beginPath();                                // blade
            ctx.moveTo(px - 3 * Math.cos(spin), py - 3 * Math.sin(spin));
            ctx.lineTo(px + 3 * Math.cos(spin), py + 3 * Math.sin(spin));
            ctx.stroke();
        }
        ctx.restore();
    }

    // top view of a small differential-drive rover: body, two wheels, front marker
    function drawRover(r, leader) {
        ctx.save();
        ctx.translate(r.x, r.y);
        ctx.rotate(r.theta);
        ctx.fillStyle = INK;
        ctx.globalAlpha = 0.6;
        ctx.fillRect(-4.5, -6.5, 9, 2.4);
        ctx.fillRect(-4.5, 4.1, 9, 2.4);
        ctx.globalAlpha = leader ? 0.65 : 0.45;
        ctx.beginPath();
        if (ctx.roundRect) ctx.roundRect(-5.5, -4, 11, 8, 2.5);
        else ctx.rect(-5.5, -4, 11, 8);
        ctx.fill();
        ctx.restore();
        const fx = r.x + 3 * Math.cos(r.theta);
        const fy = r.y + 3 * Math.sin(r.theta);
        dot(fx, fy, 1.5, 0.95, '#fff');                      // front marker
    }

    function draw() {
        ctx.clearRect(0, 0, width, height);
        ctx.globalAlpha = 1;
        ctx.drawImage(gridLayer, 0, 0, width, height);
        ctx.strokeStyle = INK;
        ctx.lineWidth = 1;

        // AI: leader sensing cone and sampled candidate trajectories
        for (const t of teams) {
            if (t.wait > 0) continue;
            const L = t.leader;
            ctx.globalAlpha = 0.05;
            ctx.fillStyle = INK;
            ctx.beginPath();
            if (t.air) {
                ctx.arc(L.x, L.y, SENSE * 0.7, 0, Math.PI * 2);   // downward camera footprint
            } else {
                ctx.moveTo(L.x, L.y);
                ctx.arc(L.x, L.y, SENSE, L.theta - FOV, L.theta + FOV);   // forward sensing cone
                ctx.closePath();
            }
            ctx.fill();
            if (t.rollouts) {
                t.rollouts.paths.forEach((path, i) => {
                    const best = i === t.rollouts.best;
                    ctx.globalAlpha = best ? 0.32 : 0.1;
                    ctx.lineWidth = best ? 1.3 : 1;
                    ctx.beginPath();
                    ctx.moveTo(L.x, L.y);
                    for (const p of path) ctx.lineTo(p.x, p.y);
                    ctx.stroke();
                });
                ctx.lineWidth = 1;
            }
        }
        // fading trails (dashed for drones)
        for (const t of teams) {
            if (t.air) ctx.setLineDash([2, 3]);
            for (const r of [t.leader, ...t.followers]) {
                for (let i = 1; i < r.trail.length; i++) {
                    line(r.trail[i - 1].x, r.trail[i - 1].y, r.trail[i].x, r.trail[i].y, (i / r.trail.length) * 0.25);
                }
            }
            ctx.setLineDash([]);
        }
        // links between nearby teams
        ctx.setLineDash([2, 6]);
        for (let a = 0; a < teams.length; a++) {
            for (let b = a + 1; b < teams.length; b++) {
                const A = teams[a].leader;
                const B = teams[b].leader;
                const d = Math.hypot(A.x - B.x, A.y - B.y);
                if (d < 280) line(A.x, A.y, B.x, B.y, 0.28 * (1 - d / 280));
            }
        }
        // planned route to the task
        ctx.setLineDash([3, 5]);
        for (const t of teams) {
            let from = t.leader;
            for (const wp of t.route) { line(from.x, from.y, wp.x, wp.y, 0.16); from = wp; }
        }
        ctx.setLineDash([]);
        // finished tasks stay as faint marks
        done.forEach((d, i) => drawTask(d, 0.1 + 0.1 * (i / done.length)));
        for (const t of teams) {
            // current task: icon, brighter while the team is working on it
            const g = t.route[t.route.length - 1];
            drawTask(g, t.wait > 0 ? 0.65 : 0.38);
            if (detected(t.leader, g, t.air) || t.wait > 0) drawDetection(g, t.wait > 0 ? 0.6 : 0.45);
            // team comm links (leader to followers)
            for (const f of t.followers) line(t.leader.x, t.leader.y, f.x, f.y, 0.2);
        }
        // task-complete pulses
        for (const p of pulses) {
            ctx.globalAlpha = 0.45 * (1 - p.age / 60);
            ctx.beginPath();
            ctx.arc(p.x, p.y, 6 + p.age * 0.55, 0, Math.PI * 2);
            ctx.stroke();
        }
        // messages travelling along the links
        for (const p of packets) {
            dot(p.from.x + (p.to.x - p.from.x) * p.t, p.from.y + (p.to.y - p.from.y) * p.t, 1.8, 0.75);
        }
        for (const t of teams) {
            const drawRobot = t.air ? drawDrone : drawRover;
            drawRobot(t.leader, true);
            t.followers.forEach((f) => drawRobot(f, false));
        }
    }

    function frame() {
        if (!running) return;
        step();
        draw();
        requestAnimationFrame(frame);
    }

    resize();
    draw();
    if (document.fonts) document.fonts.ready.then(() => { resize(); draw(); });

    if (!reduceMotion) {
        // Only animate while the hero is on screen
        new IntersectionObserver(([entry]) => {
            running = entry.isIntersecting;
            if (running) requestAnimationFrame(frame);
        }).observe(canvas);
    }

    let resizeTimer;
    window.addEventListener('resize', () => {
        clearTimeout(resizeTimer);
        // mobile browsers fire resize when the address bar hides; only restart on a real width change
        resizeTimer = setTimeout(() => {
            if (canvas.clientWidth !== width) { resize(); draw(); }
        }, 150);
    });
}
