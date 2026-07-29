/**
 * 全球地图打卡 - 纯前端版本 (无需后端)
 * 使用 localStorage 存储个人数据, jsonblob.com 实现全球排行榜共享
 */

// ==================== 配置 ====================
const JSONBLOB_INITIAL_ID = '019fa803-0501-7f55-8703-905b3b7d7d9a';
const JSONBLOB_BASE = 'https://jsonblob.com/api/jsonBlob';

// ==================== 状态管理 ====================
const state = {
  user: null,
  deviceId: null,
  map: null,
  markers: [],
  boundaryLayers: [],
  pendingMarker: null,
  pendingBoundary: null,
  pendingRegion: null,
  tileLayer: null,
  theme: 'light',
  orientation: 'auto',
  currentLayout: 'portrait',
  regionsCache: null,
  lastClickLat: null,
  lastClickLng: null,
  lastClickTime: 0,
  leaderboardBlobId: null
};

// ==================== 工具函数 ====================
function getDeviceId() {
  let id = localStorage.getItem('mc_device_id');
  if (!id) {
    id = 'd_' + Date.now().toString(36) + Math.random().toString(36).substr(2, 8);
    localStorage.setItem('mc_device_id', id);
  }
  return id;
}

function saveUser(user) {
  state.user = user;
  localStorage.setItem('mc_user', JSON.stringify(user));
}

function loadUser() {
  const saved = localStorage.getItem('mc_user');
  if (saved) {
    try {
      state.user = JSON.parse(saved);
    } catch (e) {
      state.user = null;
    }
  }
}

// 获取本地打卡记录
function getLocalCheckins() {
  const saved = localStorage.getItem('mc_checkins');
  if (saved) {
    try {
      return JSON.parse(saved);
    } catch (e) {
      return [];
    }
  }
  return [];
}

// 保存本地打卡记录
function saveLocalCheckins(checkins) {
  localStorage.setItem('mc_checkins', JSON.stringify(checkins));
}

// 添加打卡
function addLocalCheckin(checkin) {
  const checkins = getLocalCheckins();
  // 检查是否已存在
  const existing = checkins.find(c => c.region_code === checkin.region_code);
  if (existing) {
    return { success: true, alreadyChecked: true };
  }
  checkins.push(checkin);
  saveLocalCheckins(checkins);
  return { success: true, alreadyChecked: false };
}

// 删除打卡
function removeLocalCheckin(regionCode) {
  let checkins = getLocalCheckins();
  checkins = checkins.filter(c => c.region_code !== regionCode);
  saveLocalCheckins(checkins);
  return { success: true };
}

// 检查是否已打卡
function isCheckedIn(regionCode) {
  const checkins = getLocalCheckins();
  return checkins.some(c => c.region_code === regionCode);
}

function showToast(message, type = '') {
  const toast = document.getElementById('toast');
  toast.textContent = message;
  toast.className = 'toast show ' + type;
  setTimeout(() => {
    toast.className = 'toast ' + type;
  }, 2500);
}

function escapeHtml(text) {
  if (!text) return '';
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

// ==================== jsonblob 排行榜 ====================

// 获取当前 blob ID (localStorage 优先, 回退到硬编码)
function getBlobId() {
  if (state.leaderboardBlobId) return state.leaderboardBlobId;
  const stored = localStorage.getItem('mc_blob_id');
  state.leaderboardBlobId = stored || JSONBLOB_INITIAL_ID;
  return state.leaderboardBlobId;
}

// 设置当前 blob ID
function setBlobId(id) {
  state.leaderboardBlobId = id;
  localStorage.setItem('mc_blob_id', id);
}

// 读取排行榜数据
async function readLeaderboard() {
  const blobId = getBlobId();
  try {
    const resp = await fetch(`${JSONBLOB_BASE}/${blobId}`);
    if (resp.ok) {
      const data = await resp.json();
      // 检查是否有 nextBlobId (链式更新)
      if (data.nextBlobId) {
        setBlobId(data.nextBlobId);
        return readLeaderboard(); // 递归读取新 blob
      }
      return data;
    } else if (resp.status === 404) {
      // Blob 已过期, 尝试创建新的
      return await createLeaderboardBlob();
    }
  } catch (e) {
    console.warn('Read leaderboard failed:', e.message);
  }
  return null;
}

// 写入排行榜数据
async function writeLeaderboard(data) {
  const blobId = getBlobId();
  try {
    const resp = await fetch(`${JSONBLOB_BASE}/${blobId}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data)
    });
    return resp.ok;
  } catch (e) {
    console.warn('Write leaderboard failed:', e.message);
    return false;
  }
}

// 创建新的排行榜 blob
async function createLeaderboardBlob() {
  // 用本地缓存的数据初始化
  const localLb = localStorage.getItem('mc_leaderboard_cache');
  let data;
  if (localLb) {
    try {
      data = JSON.parse(localLb);
    } catch (e) {
      data = { users: {}, lastUpdate: new Date().toISOString() };
    }
  } else {
    data = { users: {}, lastUpdate: new Date().toISOString() };
  }

  try {
    const resp = await fetch(JSONBLOB_BASE, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data)
    });
    if (resp.ok || resp.status === 201) {
      // 从 Location header 获取新 blob ID
      const location = resp.headers.get('Location') || '';
      const match = location.match(/\/([0-9a-f-]+)$/);
      if (match) {
        const newId = match[1];
        setBlobId(newId);

        // 尝试更新旧 blob 指向新 blob (链式跳转)
        const oldId = JSONBLOB_INITIAL_ID;
        if (oldId !== newId) {
          try {
            await fetch(`${JSONBLOB_BASE}/${oldId}`, {
              method: 'PUT',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ ...data, nextBlobId: newId })
            });
          } catch (e) { /* 忽略 */ }
        }

        return data;
      }
    }
  } catch (e) {
    console.warn('Create leaderboard blob failed:', e.message);
  }
  return null;
}

// 更新当前用户在排行榜中的数据
async function updateUserInLeaderboard() {
  if (!state.user) return;

  const checkins = getLocalCheckins();
  const countries = new Set(checkins.map(c => c.country).filter(Boolean));
  const regionCodes = checkins.map(c => c.region_code);

  const userEntry = {
    nickname: state.user.nickname,
    checkinCount: checkins.length,
    countries: [...countries],
    regions: regionCodes,
    lastUpdate: new Date().toISOString()
  };

  // 读取当前排行榜
  let lb = await readLeaderboard();
  if (!lb) {
    // jsonblob 不可用, 使用本地缓存
    lb = { users: {}, lastUpdate: new Date().toISOString() };
  }

  // 更新用户数据
  if (!lb.users) lb.users = {};
  lb.users[state.deviceId] = userEntry;
  lb.lastUpdate = new Date().toISOString();

  // 缓存到本地
  localStorage.setItem('mc_leaderboard_cache', JSON.stringify(lb));

  // 写回 jsonblob
  await writeLeaderboard(lb);
}

// ==================== 主题管理 ====================
function initTheme() {
  const saved = localStorage.getItem('mc_theme');
  const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
  state.theme = saved || (prefersDark ? 'dark' : 'light');
  applyTheme();
}

function applyTheme() {
  document.documentElement.setAttribute('data-theme', state.theme);
  localStorage.setItem('mc_theme', state.theme);
}

function toggleTheme() {
  state.theme = state.theme === 'light' ? 'dark' : 'light';
  applyTheme();
}

// ==================== 横竖屏管理 ====================
function initOrientation() {
  const saved = localStorage.getItem('mc_orientation');
  state.orientation = saved || 'auto';
  applyOrientation();

  let resizeTimer = null;
  window.addEventListener('resize', () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => {
      if (state.orientation === 'auto') applyOrientation();
    }, 200);
  });

  window.addEventListener('orientationchange', () => {
    setTimeout(() => {
      if (state.orientation === 'auto') applyOrientation();
    }, 150);
  });
}

function detectAutoLayout() {
  const w = window.innerWidth;
  const h = window.innerHeight;
  const isLandscape = w > h;
  if (w < 768) return isLandscape ? 'landscape' : 'portrait';
  return 'portrait';
}

function applyOrientation() {
  let layout;
  if (state.orientation === 'auto') {
    layout = detectAutoLayout();
  } else {
    layout = state.orientation;
  }
  const changed = state.currentLayout !== layout;
  state.currentLayout = layout;
  document.body.setAttribute('data-layout', layout);
  const btn = document.getElementById('orientation-toggle');
  if (btn) btn.setAttribute('data-mode', state.orientation);
  if (changed && state.map) {
    setTimeout(() => state.map.invalidateSize(), 350);
  }
}

function toggleOrientation() {
  const cycle = ['auto', 'portrait', 'landscape'];
  const idx = cycle.indexOf(state.orientation);
  state.orientation = cycle[(idx + 1) % cycle.length];
  localStorage.setItem('mc_orientation', state.orientation);
  applyOrientation();
  const labels = { auto: '自动模式', portrait: '竖屏模式', landscape: '横屏模式' };
  showToast(labels[state.orientation], 'success');
}

function updateMapTiles() {
  if (state.tileLayer) state.map.removeLayer(state.tileLayer);
  const tileUrl = 'https://webrd0{s}.is.autonavi.com/appmaptile?lang=zh_cn&size=1&scale=1&style=8&x={x}&y={y}&z={z}';
  state.tileLayer = L.tileLayer(tileUrl, {
    attribution: '&copy; 高德地图',
    subdomains: ['1', '2', '3', '4'],
    maxZoom: 18
  }).addTo(state.map);
}

// ==================== 用户认证 (本地) ====================
async function ensureLogin() {
  loadUser();
  if (state.user && state.user.id) return state.user;

  state.deviceId = getDeviceId();
  const user = {
    id: Date.now(),
    deviceId: state.deviceId,
    nickname: '旅行者' + Math.floor(Math.random() * 10000),
    totalCheckins: 0,
    createdAt: new Date().toISOString()
  };
  saveUser(user);
  return user;
}

// ==================== 区域数据加载 ====================
async function loadRegions() {
  if (state.regionsCache) return state.regionsCache;
  try {
    const resp = await fetch('regions.json?v=20260729a');
    if (resp.ok) {
      const data = await resp.json();
      state.regionsCache = data.regions;
      return data.regions;
    }
  } catch (e) {
    console.error('Load regions failed:', e);
  }
  return [];
}

// ==================== 逆地理编码 (客户端) ====================
// 使用最近邻匹配 + 中国 DataV 省份验证
function haversineDistance(lat1, lng1, lat2, lng2) {
  const R = 6371;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLng = (lng2 - lng1) * Math.PI / 180;
  const a = Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
    Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function findNearestRegion(lat, lng, regions) {
  let minDist = Infinity;
  let nearest = null;
  for (const r of regions) {
    const dist = haversineDistance(lat, lng, r.lat, r.lng);
    if (dist < minDist) {
      minDist = dist;
      nearest = r;
    }
  }
  if (minDist > 500) return null; // 超过500km不匹配
  return nearest;
}

async function reverseGeocode(lat, lng) {
  const regions = await loadRegions();
  if (regions.length === 0) return null;

  // 中国区域: 尝试用 DataV 省份边界精确匹配
  if (lat > 15 && lat < 55 && lng > 70 && lng < 140) {
    try {
      const provinceData = await fetch('https://geo.datav.aliyun.com/areas_v3/bound/100000_full.json');
      if (provinceData.ok) {
        const geojson = await provinceData.json();
        for (const feature of geojson.features) {
          const coords = feature.geometry.type === 'Polygon'
            ? [feature.geometry.coordinates]
            : feature.geometry.coordinates;
          for (const poly of coords) {
            const ring = poly[0];
            if (isPointInPolygon(lng, lat, ring)) {
              const provinceName = feature.properties.name;
              // 在该省份内找最近的城市
              const provinceCities = regions.filter(r =>
                r.country === '中国' && r.province === provinceName
              );
              if (provinceCities.length > 0) {
                const nearest = findNearestRegion(lat, lng, provinceCities);
                if (nearest) {
                  return {
                    code: nearest.code,
                    name: nearest.name,
                    type: nearest.type,
                    country: nearest.country,
                    province: nearest.province || '',
                    lat: lat,
                    lng: lng
                  };
                }
              }
              break;
            }
          }
        }
      }
    } catch (e) {
      console.warn('DataV province match failed:', e.message);
    }
  }

  // 回退: 最近邻匹配
  const nearest = findNearestRegion(lat, lng, regions);
  if (nearest) {
    return {
      code: nearest.code,
      name: nearest.name,
      type: nearest.type,
      country: nearest.country,
      province: nearest.province || '',
      lat: lat,
      lng: lng
    };
  }
  return null;
}

// 点在多边形内 (Ray Casting) - coordinates 为 [lng, lat]
function isPointInPolygon(lng, lat, polygon) {
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const xi = polygon[i][0], yi = polygon[i][1];
    const xj = polygon[j][0], yj = polygon[j][1];
    const intersect = ((yi > lat) !== (yj > lat)) &&
      (lng < (xj - xi) * (lat - yi) / (yj - yi) + xi);
    if (intersect) inside = !inside;
  }
  return inside;
}

// ==================== 区域边界获取 ====================

// 边界缓存版本号 - 升级时递增, 自动清空旧版缓存
const BOUNDARY_CACHE_VERSION = 3;

// 检查并清理旧版缓存 (无 isReal 标记的视为旧版/失败缓存)
function migrateBoundaryCache() {
  try {
    const v = localStorage.getItem('mc_boundary_cache_version');
    if (v !== String(BOUNDARY_CACHE_VERSION)) {
      const keys = [];
      for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i);
        if (k && k.startsWith('mc_boundary_')) keys.push(k);
      }
      keys.forEach(k => localStorage.removeItem(k));
      localStorage.setItem('mc_boundary_cache_version', String(BOUNDARY_CACHE_VERSION));
      console.log(`[migrate] cleared ${keys.length} stale boundary cache entries (v${BOUNDARY_CACHE_VERSION})`);
    }
  } catch (e) {}
}

// 边界缓存 (localStorage, 避免重复请求 API)
// 真实边界 (isReal=true) 优先, fallback 圆 (isFallback=true) 兜底
// 两个都打标, getCachedBoundary 只信任带标记的
function getCachedBoundary(code) {
  try {
    const cached = JSON.parse(localStorage.getItem('mc_boundary_' + code));
    if (cached && cached.polygons && cached.polygons.length > 0) {
      if (cached.isReal === true || cached.isFallback === true) {
        return cached;
      }
    }
  } catch (e) {}
  return null;
}

function setCachedBoundary(code, polygons) {
  try {
    localStorage.setItem('mc_boundary_' + code, JSON.stringify({
      polygons,
      isReal: true,
      ts: Date.now()
    }));
  } catch (e) {}
}

function setFallbackBoundaryCache(code, polygons) {
  try {
    localStorage.setItem('mc_boundary_' + code, JSON.stringify({
      polygons,
      isFallback: true,
      isCircle: true,
      ts: Date.now()
    }));
  } catch (e) {}
}

// 带超时的 fetch (默认 15s, 避免 DataV 挂起时永久等待)
async function fetchWithTimeout(url, options = {}, timeoutMs = 15000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const resp = await fetch(url, { ...options, signal: controller.signal });
    return resp;
  } catch (e) {
    if (e.name === 'AbortError') {
      throw new Error(`Request timeout after ${timeoutMs}ms`);
    }
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

// 通用 fetch + 自动重试 (DataV API 偶发 000 连接失败/超时, 最多 3 次)
async function fetchWithRetry(url, options = {}, timeoutMs = 15000, retries = 3) {
  let lastErr = null;
  for (let i = 0; i < retries; i++) {
    try {
      const resp = await fetchWithTimeout(url, options, timeoutMs);
      if (resp.ok) return resp;
      lastErr = new Error(`HTTP ${resp.status}`);
      // 5xx / 403 才有重试意义, 404 直接放弃
      if (resp.status === 404) return resp;
    } catch (e) {
      lastErr = e;
      console.warn(`[fetchWithRetry] ${url} attempt ${i + 1}/${retries} failed: ${e.message}`);
    }
    if (i < retries - 1) {
      // 退避: 1s, 2s
      await new Promise(r => setTimeout(r, 1000 * (i + 1)));
    }
  }
  throw lastErr || new Error('All retries failed');
}

async function fetchBoundary(code, forceRefresh = false) {
  // 1. 检查缓存 (除非 forceRefresh)
  if (!forceRefresh) {
    const cached = getCachedBoundary(code);
    if (cached && cached.polygons && cached.polygons.length > 0) {
      return {
        success: true,
        code,
        polygons: cached.polygons,
        fromCache: true,
        isReal: cached.isReal === true,
        isCircle: cached.isFallback === true || cached.isCircle === true
      };
    }
  }

  // 2. 中国城市: 从 DataV API 获取真实边界 (3 次重试 + 15s 超时)
  if (code.startsWith('CN-')) {
    const adcode = code.replace('CN-', '');
    try {
      const resp = await fetchWithRetry(
        `https://geo.datav.aliyun.com/areas_v3/bound/${adcode}.json`,
        {},
        15000,
        3
      );
      if (resp.ok) {
        const geojson = await resp.json();
        if (geojson.features && geojson.features.length > 0) {
          const polygons = [];
          geojson.features.forEach(feature => {
            const geom = feature.geometry;
            if (geom.type === 'Polygon') {
              polygons.push(convertGeoJsonRing(geom.coordinates));
            } else if (geom.type === 'MultiPolygon') {
              geom.coordinates.forEach(poly => {
                if (poly && poly[0]) polygons.push(convertGeoJsonRing(poly));
              });
            }
          });
          if (polygons.length > 0) {
            setCachedBoundary(code, polygons);
            return { success: true, code, polygons };
          }
        }
      }
    } catch (e) {
      console.warn(`DataV fetch failed for ${code} (after retries):`, e.message);
    }
    // 中国城市 DataV 失败时: 用小圆圈作 fallback, 缓存避免反复请求
    return buildFallbackCircle(code, 0.3); // 约 30km
  }

  // 3. 国外区域: 用 Nominatim API 获取真实行政边界
  const regions = await loadRegions();
  const region = regions.find(r => r.code === code);
  if (region) {
    // 使用英文名查询 Nominatim (更准确)
    const searchName = region.nameEn || region.name;
    const searchCountry = region.countryEn || region.country;
    try {
      const query = encodeURIComponent(searchName + ', ' + searchCountry);
      const resp = await fetchWithRetry(
        `https://nominatim.openstreetmap.org/search?q=${query}&format=geojson&polygon_geojson=1&limit=1&accept-language=en`,
        { headers: { 'Accept': 'application/json' } },
        15000,
        2
      );
      if (resp.ok) {
        const data = await resp.json();
        if (data.features && data.features.length > 0) {
          const geom = data.features[0].geometry;
          const polygons = extractGeometryPolygons(geom);
          if (polygons.length > 0) {
            setCachedBoundary(code, polygons);
            return { success: true, code, polygons };
          }
        }
      }
    } catch (e) {
      console.warn(`Nominatim fetch failed for ${code} (after retries):`, e.message);
    }

    // Nominatim 失败时回退: 150km 圆 (缓存以避免反复请求)
    return buildFallbackCircle(code, 1.5);
  }

  return { success: false, polygons: [] };
}

// 通用圆形 fallback (写入缓存, 避免每次刷新都重新请求不稳定的 API)
async function buildFallbackCircle(code, radius) {
  const regions = await loadRegions();
  const region = regions.find(r => r.code === code);
  if (!region) return { success: false, polygons: [] };
  const points = [];
  for (let i = 0; i <= 64; i++) {
    const angle = (i / 64) * 2 * Math.PI;
    points.push([
      region.lat + radius * Math.sin(angle),
      region.lng + radius * Math.cos(angle) / Math.cos(region.lat * Math.PI / 180)
    ]);
  }
  const polygons = [points];
  setFallbackBoundaryCache(code, polygons);
  return { success: true, code, polygons, isCircle: true };
}

// 从 GeoJSON geometry 提取多边形 (支持 Polygon / MultiPolygon)
function extractGeometryPolygons(geom) {
  const polygons = [];
  if (!geom) return polygons;
  if (geom.type === 'Polygon') {
    polygons.push(convertGeoJsonRing(geom.coordinates));
  } else if (geom.type === 'MultiPolygon') {
    geom.coordinates.forEach(poly => {
      if (poly && poly[0]) polygons.push(convertGeoJsonRing(poly));
    });
  }
  return polygons;
}

function convertGeoJsonRing(coordinates) {
  const ring = coordinates[0];
  return ring.map(point => [point[1], point[0]]);
}

// ==================== 地图初始化 ====================
function initMap() {
  state.map = L.map('map', {
    center: [35, 105],
    zoom: 4,
    zoomControl: false,
    attributionControl: false,
    worldCopyJump: true,
    minZoom: 2,
    maxZoom: 18
  });
  L.control.zoom({ position: 'bottomright' }).addTo(state.map);
  updateMapTiles();
  state.map.on('dblclick', (e) => handleMapDoubleClick(e.latlng.lat, e.latlng.lng));
  state.map.doubleClickZoom.disable();
  state.map.on('click', () => hideSearchResults());
}

// ==================== 双击打卡处理 ====================
async function handleMapDoubleClick(lat, lng) {
  clearPendingElements();

  const icon = L.divIcon({
    className: '',
    html: '<div class="pending-marker">\u23f3</div>',
    iconSize: [36, 36],
    iconAnchor: [18, 18]
  });
  state.pendingMarker = L.marker([lat, lng], { icon }).addTo(state.map);
  showToast('正在识别区域...', '');

  try {
    const region = await reverseGeocode(lat, lng);
    if (region) {
      // 检查是否已打卡
      if (isCheckedIn(region.code)) {
        showToast('该区域已打卡', 'error');
        clearPendingElements();
        return;
      }

      // 获取边界
      try {
        const boundaryData = await fetchBoundary(region.code);
        if (boundaryData.success && boundaryData.polygons && boundaryData.polygons.length > 0) {
          boundaryData.polygons.forEach(polygon => {
            if (polygon.length >= 3) {
              const poly = L.polygon(polygon, {
                color: '#f59e0b', weight: 2, opacity: 0.8,
                fillColor: '#fbbf24', fillOpacity: 0.15,
                dashArray: '8, 4', className: 'pending-boundary'
              }).addTo(state.map);
              if (!state.pendingBoundary) state.pendingBoundary = [];
              state.pendingBoundary.push(poly);
            }
          });
        }
      } catch (e) {
        console.warn('Failed to fetch boundary:', e);
      }

      state.pendingRegion = { ...region, lat, lng };
      showCheckinModal(region, lat, lng);
    } else {
      showToast('无法识别该位置的区域', 'error');
      clearPendingElements();
    }
  } catch (err) {
    showToast('识别失败：' + (err.message || '网络错误'), 'error');
    clearPendingElements();
  }
}

function clearPendingElements() {
  if (state.pendingMarker) { state.map.removeLayer(state.pendingMarker); state.pendingMarker = null; }
  if (state.pendingBoundary) { state.pendingBoundary.forEach(p => state.map.removeLayer(p)); state.pendingBoundary = null; }
}

function showCheckinModal(region, lat, lng) {
  const modal = document.getElementById('checkin-modal');
  document.getElementById('checkin-region-name').textContent = region.name || '未知区域';
  let infoParts = [];
  if (region.country) infoParts.push(region.country);
  if (region.province && region.province !== region.name) infoParts.push(region.province);
  if (region.type) {
    const typeMap = { city: '地级市', prefecture_city: '地级市', province: '省/州', state: '州', region: '区域', municipality: '直辖市', prefecture: '地级市', district: '区/县' };
    infoParts.push(typeMap[region.type] || region.type);
  }
  document.getElementById('checkin-region-info').textContent = infoParts.join(' · ');
  document.getElementById('checkin-coords').textContent = `${lat.toFixed(4)}\u00b0, ${lng.toFixed(4)}\u00b0`;
  modal.classList.add('show');
}

function hideCheckinModal() {
  document.getElementById('checkin-modal').classList.remove('show');
  clearPendingElements();
  state.pendingRegion = null;
}

async function confirmCheckin() {
  if (!state.pendingRegion || !state.user) { showToast('请先登录', 'error'); return; }
  const region = state.pendingRegion;

  const checkin = {
    region_code: region.code,
    region_name: region.name,
    region_type: region.type || 'city',
    country: region.country || '',
    province: region.province || '',
    latitude: region.lat,
    longitude: region.lng,
    created_at: new Date().toISOString()
  };

  const result = addLocalCheckin(checkin);
  if (result.success) {
    // 转换待确认边界为已打卡样式
    if (state.pendingBoundary) {
      state.pendingBoundary.forEach(poly => {
        poly.setStyle({ color: '#10b981', fillColor: '#10b981', fillOpacity: 0.12, dashArray: null, className: 'checked-boundary' });
        state.boundaryLayers.push(poly);
      });
      state.pendingBoundary = null;
    }
    if (state.pendingMarker) { state.map.removeLayer(state.pendingMarker); state.pendingMarker = null; }

    hideCheckinModal();
    showSuccessAnimation();

    // 更新用户数据
    state.user.totalCheckins = getLocalCheckins().length;
    saveUser(state.user);

    // 同步清单和排行榜
    checklistState.checkedCodes.add(region.code);
    updateMapStats();
    updateUserInLeaderboard(); // 异步更新排行榜, 不等待

    if (document.getElementById('view-leaderboard').classList.contains('active')) loadLeaderboard();
    if (document.getElementById('view-profile').classList.contains('active')) loadProfile();

    setTimeout(() => {
      showToast(result.alreadyChecked ? '该区域已打卡' : '打卡成功！+1', 'success');
    }, 800);
  } else {
    showToast('打卡失败', 'error');
  }
}

function showSuccessAnimation() {
  const success = document.getElementById('checkin-success');
  success.classList.add('show');
  setTimeout(() => success.classList.remove('show'), 1400);
}

// ==================== 地图标记 ====================
async function loadCheckedMarkers(forceRefresh = false) {
  if (!state.user) return;

  // 清除旧边界
  state.markers.forEach(m => state.map.removeLayer(m));
  state.markers = [];
  state.boundaryLayers.forEach(b => state.map.removeLayer(b));
  state.boundaryLayers = [];

  const checkins = getLocalCheckins();

  // 并行加载所有城市边界 (一个慢不影响其他)
  // 单个失败用 Promise.allSettled 隔离, 不影响其他
  const settled = await Promise.allSettled(
    checkins.map(r => fetchBoundary(r.region_code, forceRefresh))
  );

  settled.forEach((result, idx) => {
    const r = checkins[idx];
    if (result.status !== 'fulfilled') {
      console.warn(`Boundary load failed for ${r.region_code}:`, result.reason);
      return;
    }
    const boundaryData = result.value;
    if (!boundaryData.success || !boundaryData.polygons) return;

    // 失败 fallback 的小圆圈用浅黄色虚线 (区别于已打卡的绿色实线)
    const isFallback = !!boundaryData.isCircle;
    const style = isFallback ? {
      color: '#f59e0b', weight: 1.5, opacity: 0.7,
      fillColor: '#fbbf24', fillOpacity: 0.10,
      dashArray: '6, 4', className: 'pending-boundary'
    } : {
      color: '#10b981', weight: 2, opacity: 0.7,
      fillColor: '#10b981', fillOpacity: 0.12,
      className: 'checked-boundary'
    };

    boundaryData.polygons.forEach(polygon => {
      if (polygon.length >= 3) {
        const poly = L.polygon(polygon, style).addTo(state.map);
        if (isFallback) {
          // Fallback 圆: 加"重试"按钮
          const retryBtn = `<br><a href="#" onclick="retryBoundary('${r.region_code}'); return false;" style="color:#3b82f6; text-decoration:underline;">↻ 重新加载真实边界</a>`;
          poly.bindPopup(`<b>${escapeHtml(r.region_name)}</b><br>已打卡 (边界暂未加载)${retryBtn}`, { className: 'checkin-popup' });
        } else {
          poly.bindPopup(`<b>${escapeHtml(r.region_name)}</b><br>已打卡`, { className: 'checkin-popup' });
        }
        state.boundaryLayers.push(poly);
      }
    });
  });

  updateMapStats(checkins.length);
}

// 用户点 popup 的"重试"按钮, 强制重新 fetch 单个城市的边界
window.retryBoundary = async function(code) {
  state.map.closePopup();
  showToast('正在重新加载边界...', '');
  // 强制清掉该城市的缓存
  try { localStorage.removeItem('mc_boundary_' + code); } catch (e) {}
  // 重新加载所有边界 (forceRefresh=true 会跳过缓存, 重新 fetch)
  await loadCheckedMarkers(true);
  showToast('已重新加载', 'success');
};

function updateMapStats(count) {
  const checkinCount = count !== undefined ? count : (state.user ? state.user.totalCheckins : 0);
  document.getElementById('stat-checkins').textContent = checkinCount;
}

// ==================== 搜索功能 (客户端) ====================
let searchTimer = null;

function setupSearch() {
  const input = document.getElementById('search-input');
  const clearBtn = document.getElementById('search-clear');

  input.addEventListener('input', (e) => {
    const query = e.target.value.trim();
    if (query) { clearBtn.style.display = 'flex'; } else { clearBtn.style.display = 'none'; hideSearchResults(); return; }
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => searchRegions(query), 300);
  });

  clearBtn.addEventListener('click', () => {
    input.value = ''; clearBtn.style.display = 'none'; hideSearchResults(); input.focus();
  });

  document.addEventListener('click', (e) => {
    if (!e.target.closest('.map-top-bar')) hideSearchResults();
  });
}

async function searchRegions(query) {
  if (query.length < 1) return;
  const regions = await loadRegions();
  const keyword = query.toLowerCase();
  const results = regions.filter(r =>
    (r.name && r.name.toLowerCase().includes(keyword)) ||
    (r.country && r.country.toLowerCase().includes(keyword)) ||
    (r.province && r.province.toLowerCase().includes(keyword)) ||
    (r.code && r.code.toLowerCase().includes(keyword))
  ).slice(0, 20);
  displaySearchResults(results);
}

function displaySearchResults(results) {
  const container = document.getElementById('search-results');
  if (!results || results.length === 0) {
    container.innerHTML = '<div class="search-result-item"><div class="search-result-name">未找到相关区域</div></div>';
    container.style.display = 'block';
    return;
  }
  container.innerHTML = results.slice(0, 10).map(r => `
    <div class="search-result-item" data-lat="${r.lat}" data-lng="${r.lng}" data-name="${escapeHtml(r.name)}">
      <div class="search-result-name">${escapeHtml(r.name)}</div>
      <div class="search-result-info">${r.country || ''}${r.province ? ' \u00b7 ' + r.province : ''}</div>
    </div>
  `).join('');
  container.style.display = 'block';
  container.querySelectorAll('.search-result-item').forEach(item => {
    item.addEventListener('click', () => {
      const lat = parseFloat(item.dataset.lat);
      const lng = parseFloat(item.dataset.lng);
      const name = item.dataset.name;
      state.map.flyTo([lat, lng], 8, { duration: 1.5 });
      hideSearchResults();
      const tempIcon = L.divIcon({ className: '', html: '<div class="pending-marker">\ud83d\udccd</div>', iconSize: [36, 36], iconAnchor: [18, 18] });
      if (state.pendingMarker) state.map.removeLayer(state.pendingMarker);
      state.pendingMarker = L.marker([lat, lng], { icon: tempIcon }).addTo(state.map);
      state.pendingMarker.bindPopup(`<b>${escapeHtml(name)}</b><br>双击地图可打卡`).openPopup();
      document.getElementById('search-input').value = '';
      document.getElementById('search-clear').style.display = 'none';
    });
  });
}

function hideSearchResults() {
  document.getElementById('search-results').style.display = 'none';
}

// ==================== 排行榜 (jsonblob) ====================
async function loadLeaderboard() {
  try {
    const lb = await readLeaderboard();

    if (!lb || !lb.users) {
      // jsonblob 不可用, 使用本地缓存
      const localLb = localStorage.getItem('mc_leaderboard_cache');
      if (localLb) {
        displayLeaderboard(JSON.parse(localLb));
      } else {
        displayEmptyLeaderboard();
      }
      return;
    }

    // 缓存到本地
    localStorage.setItem('mc_leaderboard_cache', JSON.stringify(lb));
    displayLeaderboard(lb);
  } catch (err) {
    console.error('Load leaderboard failed:', err);
    displayEmptyLeaderboard();
  }
}

function displayLeaderboard(lb) {
  const users = lb.users || {};
  const userList = Object.values(users).filter(u => u.checkinCount > 0);
  userList.sort((a, b) => b.checkinCount - a.checkinCount);

  // 统计
  const totalUsers = userList.length;
  const totalCheckins = userList.reduce((sum, u) => sum + u.checkinCount, 0);
  const allRegions = new Set();
  userList.forEach(u => (u.regions || []).forEach(r => allRegions.add(r)));

  document.getElementById('lb-total-users').textContent = totalUsers;
  document.getElementById('lb-total-checkins').textContent = totalCheckins;
  document.getElementById('lb-unique-regions').textContent = allRegions.size;

  // 我的排名
  if (state.user && state.deviceId && users[state.deviceId]) {
    const myData = users[state.deviceId];
    const myRank = userList.findIndex(u => u.checkinCount === myData.checkinCount && u.nickname === myData.nickname) + 1;
    const percentile = totalUsers > 1 ? Math.round((1 - myRank / totalUsers) * 100) : 100;
    document.getElementById('my-rank-num').textContent = '#' + (myRank || '--');
    document.getElementById('my-rank-name').textContent = state.user.nickname;
    document.getElementById('my-rank-checkins').textContent = myData.checkinCount;
    document.getElementById('my-rank-percentile').textContent = percentile;
  } else if (state.user) {
    document.getElementById('my-rank-num').textContent = '--';
    document.getElementById('my-rank-name').textContent = state.user.nickname;
    document.getElementById('my-rank-checkins').textContent = state.user.totalCheckins || 0;
    document.getElementById('my-rank-percentile').textContent = 0;
  }

  // 排行榜列表
  const listEl = document.getElementById('leaderboard-list');
  if (userList.length === 0) {
    listEl.innerHTML = `<div class="empty-state"><div class="empty-icon">\ud83c\udfc6</div><p>还没有人打卡</p><p class="empty-hint">成为第一个打卡的人！</p></div>`;
  } else {
    listEl.innerHTML = userList.slice(0, 50).map((u, i) => {
      const rank = i + 1;
      let rankClass = '';
      if (rank === 1) rankClass = 'gold';
      else if (rank === 2) rankClass = 'silver';
      else if (rank === 3) rankClass = 'bronze';
      const rankDisplay = rank <= 3 ? ['\ud83e\udd47', '\ud83e\udd48', '\ud83e\udd49'][rank - 1] : rank;
      const flag = (u.countries && u.countries[0]) ? (countryFlags[u.countries[0]] || '\ud83c\udf0d') : '\ud83c\udf0d';
      return `<div class="lb-item"><div class="lb-rank ${rankClass}">${rankDisplay}</div><div class="lb-avatar">${flag}</div><div class="lb-info"><div class="lb-name">${escapeHtml(u.nickname)}</div><div class="lb-country">${(u.countries || []).join(', ') || '未知'}</div></div><div><div class="lb-count">${u.checkinCount}</div><div class="lb-count-label">打卡</div></div></div>`;
    }).join('');
  }

  // 热门区域
  const regionCount = {};
  userList.forEach(u => (u.regions || []).forEach(r => { regionCount[r] = (regionCount[r] || 0) + 1; }));
  const hotRegions = Object.entries(regionCount).sort((a, b) => b[1] - a[1]).slice(0, 10);

  const hotEl = document.getElementById('hot-regions');
  if (hotRegions.length === 0) {
    hotEl.innerHTML = '<p style="text-align:center;color:var(--text-secondary);padding:20px;">暂无数据</p>';
  } else {
    hotEl.innerHTML = hotRegions.map(([code, count]) => {
      const region = (state.regionsCache || []).find(r => r.code === code);
      const name = region ? region.name : code;
      const country = region ? region.country : '';
      const province = region ? region.province : '';
      return `<div class="hot-region-card"><div class="hot-region-name">${escapeHtml(name)}</div><div class="hot-region-country">${country}${province ? ' \u00b7 ' + province : ''}</div><div class="hot-region-count">${count}</div><div class="hot-region-count-label">人打卡</div></div>`;
    }).join('');
  }
}

function displayEmptyLeaderboard() {
  document.getElementById('lb-total-users').textContent = '0';
  document.getElementById('lb-total-checkins').textContent = '0';
  document.getElementById('lb-unique-regions').textContent = '0';
  document.getElementById('leaderboard-list').innerHTML = `<div class="empty-state"><div class="empty-icon">\ud83c\udfc6</div><p>排行榜加载中...</p><p class="empty-hint">打卡后将出现在排行榜上</p></div>`;
  document.getElementById('hot-regions').innerHTML = '';
}

// ==================== 个人中心 ====================
async function loadProfile() {
  if (!state.user) return;

  const checkins = getLocalCheckins();
  state.user.totalCheckins = checkins.length;
  saveUser(state.user);

  document.getElementById('profile-name').textContent = state.user.nickname;
  document.getElementById('profile-avatar').textContent = '\ud83d\udc30';
  document.getElementById('profile-checkins').textContent = checkins.length;

  const countries = new Set(checkins.map(c => c.country).filter(Boolean));
  document.getElementById('profile-countries').textContent = countries.size;

  // 排名从排行榜计算
  try {
    const lb = await readLeaderboard();
    if (lb && lb.users && lb.users[state.deviceId]) {
      const userList = Object.values(lb.users).filter(u => u.checkinCount > 0).sort((a, b) => b.checkinCount - a.checkinCount);
      const myRank = userList.findIndex(u => u.nickname === state.user.nickname) + 1;
      document.getElementById('profile-rank').textContent = myRank > 0 ? '#' + myRank : '--';
    } else {
      document.getElementById('profile-rank').textContent = '--';
    }
  } catch (e) {
    document.getElementById('profile-rank').textContent = '--';
  }

  // 进度条
  const total = 972;
  const current = checkins.length;
  const percent = Math.min((current / total) * 100, 100);
  document.getElementById('progress-text').textContent = `${current} / ${total}`;
  document.getElementById('progress-fill').style.width = percent + '%';

  // 打卡记录
  const listEl = document.getElementById('checkin-list');
  if (checkins.length === 0) {
    listEl.innerHTML = `<div class="empty-state"><div class="empty-icon">\ud83d\uddfa\ufe0f</div><p>还没有打卡记录</p><p class="empty-hint">去地图上双击打卡吧！</p></div>`;
  } else {
    const sorted = [...checkins].sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
    listEl.innerHTML = sorted.map(c => {
      const date = new Date(c.created_at).toLocaleDateString('zh-CN', { year: 'numeric', month: '2-digit', day: '2-digit' });
      const typeIcon = { city: '\ud83c\udfd9\ufe0f', prefecture_city: '\ud83c\udfd9\ufe0f', prefecture: '\ud83c\udfd9\ufe0f', municipality: '\ud83c\udfdd', province: '\ud83c\udfde', state: '\ud83c\udfde', region: '\ud83d\udccd', district: '\ud83c\udfd8\ufe0f' }[c.region_type] || '\ud83d\udccd';
      return `<div class="checkin-item"><div class="checkin-icon">${typeIcon}</div><div class="checkin-info"><div class="checkin-name">${escapeHtml(c.region_name)}</div><div class="checkin-meta">${c.country || ''}${c.province ? ' \u00b7 ' + c.province : ''}</div></div><div class="checkin-date">${date}</div></div>`;
    }).join('');
  }

  updateMapStats(checkins.length);
}

// ==================== 修改昵称 ====================
function showNameModal() {
  const modal = document.getElementById('name-modal');
  const input = document.getElementById('name-input');
  input.value = state.user.nickname;
  modal.classList.add('show');
  setTimeout(() => input.focus(), 300);
}

function hideNameModal() {
  document.getElementById('name-modal').classList.remove('show');
}

async function saveName() {
  const newName = document.getElementById('name-input').value.trim();
  if (!newName) { showToast('昵称不能为空', 'error'); return; }
  state.user.nickname = newName;
  saveUser(state.user);
  hideNameModal();
  showToast('修改成功', 'success');
  updateUserInLeaderboard(); // 更新排行榜中的昵称
  loadProfile();
}

// ==================== 城市清单 ====================
const checklistState = {
  regions: [],
  checkedCodes: new Set(),
  tree: null,
  filter: 'all',
  searchQuery: '',
  loaded: false
};

const countryFlags = {
  '中国': '\ud83c\udde8\ud83c\uddf3', '美国': '\ud83c\uddfa\ud83c\uddf8', '加拿大': '\ud83c\udde8\ud83c\udde6', '日本': '\ud83c\uddef\ud83c\uddf5', '韩国': '\ud83c\uddf0\ud83c\uddf7',
  '澳大利亚': '\ud83c\udde6\ud83c\uddfa', '英国': '\ud83c\uddec\ud83c\udde7', '法国': '\ud83c\uddeb\ud83c\uddf7', '德国': '\ud83c\udde9\ud83c\uddea', '意大利': '\ud83c\uddee\ud83c\uddf9',
  '西班牙': '\ud83c\uddea\ud83c\uddf8', '印度': '\ud83c\uddee\ud83c\uddf3', '巴西': '\ud83c\udde7\ud83c\uddf7', '墨西哥': '\ud83c\uddf2\ud83c\uddfd', '俄罗斯': '\ud83c\uddf7\ud83c\uddfa',
  '泰国': '\ud83c\uddf9\ud83c\udded', '越南': '\ud83c\uddfb\ud83c\uddf3', '新加坡': '\ud83c\uddf8\ud83c\uddec', '马来西亚': '\ud83c\uddf2\ud83c\uddfe', '印度尼西亚': '\ud83c\uddee\ud83c\udde9',
  '菲律宾': '\ud83c\uddf5\ud83c\udded', '阿联酋': '\ud83c\udde6\ud83c\uddea', '沙特阿拉伯': '\ud83c\uddf8\ud83c\uddf6', '卡塔尔': '\ud83c\uddf6\ud83c\udde6', '以色列': '\ud83c\uddee\ud83c\uddf1',
  '土耳其': '\ud83c\uddf9\ud83c\uddf7', '阿根廷': '\ud83c\udde6\ud83c\uddf7', '智利': '\ud83c\udde8\ud83c\uddf1', '哥伦比亚': '\ud83c\udde8\ud83c\uddf4', '秘鲁': '\ud83c\uddf5\ud83c\uddea',
  '南非': '\ud83c\uddff\ud83c\udde6', '埃及': '\ud83c\uddea\ud83c\uddec', '尼日利亚': '\ud83c\uddf3\ud83c\uddec', '肯尼亚': '\ud83c\uddf0\ud83c\uddea', '摩洛哥': '\ud83c\uddf2\ud83c\udde6',
  '新西兰': '\ud83c\uddff\ud83c\uddf3', '瑞士': '\ud83c\udde8\ud83c\udded', '奥地利': '\ud83c\udde6\ud83c\uddf9', '葡萄牙': '\ud83c\uddf5\ud83c\uddf9', '希腊': '\ud83c\uddec\ud83c\uddf7',
  '荷兰': '\ud83c\uddf3\ud83c\uddf1', '比利时': '\ud83c\udde7\ud83c\uddea', '瑞典': '\ud83c\uddf8\ud83c\uddea', '挪威': '\ud83c\uddf3\ud83c\uddf4', '丹麦': '\ud83c\udde9\ud83c\uddf0',
  '芬兰': '\ud83c\uddfb\ud83c\uddee', '波兰': '\ud83c\uddf5\ud83c\uddf1', '捷克': '\ud83c\udde8\ud83c\uddff', '匈牙利': '\ud83c\udded\ud83c\uddfa', '爱尔兰': '\ud83c\uddee\ud83c\uddea'
};

async function loadChecklist() {
  if (!state.user) return;
  try {
    const regions = await loadRegions();
    checklistState.regions = regions;
    const checkins = getLocalCheckins();
    checklistState.checkedCodes = new Set(checkins.map(c => c.region_code));
    checklistState.tree = buildRegionTree(regions);
    checklistState.loaded = true;
    renderChecklist();
    updateChecklistStats();
  } catch (err) {
    console.error('Load checklist failed:', err);
    document.getElementById('checklist-tree').innerHTML = '<div class="checklist-empty"><div class="empty-icon">\u26a0\ufe0f</div><p>加载失败，请刷新重试</p></div>';
  }
}

function buildRegionTree(regions) {
  const tree = {};
  regions.forEach(r => {
    if (!tree[r.country]) tree[r.country] = { name: r.country, provinces: {}, isChina: r.country === '中国' };
    if (r.country === '中国' && r.province) {
      if (!tree[r.country].provinces[r.province]) tree[r.country].provinces[r.province] = { name: r.province, cities: [] };
      tree[r.country].provinces[r.province].cities.push(r);
    } else {
      if (!tree[r.country].provinces[r.province || r.name]) tree[r.country].provinces[r.province || r.name] = { name: r.name, cities: [], isDirect: true, region: r };
      if (r.province && r.province !== r.name) tree[r.country].provinces[r.province].region = r;
    }
  });
  return tree;
}

function renderChecklist() {
  const container = document.getElementById('checklist-tree');
  const tree = checklistState.tree;
  if (!tree) { container.innerHTML = '<div class="checklist-empty">暂无数据</div>'; return; }

  const countries = Object.keys(tree).sort((a, b) => {
    if (a === '中国') return -1;
    if (b === '中国') return 1;
    return a.localeCompare(b, 'zh-CN');
  });

  let html = '';
  countries.forEach(countryName => {
    const country = tree[countryName];
    const flag = countryFlags[countryName] || '\ud83c\udf0d';
    const allRegions = country.isChina
      ? Object.values(country.provinces).flatMap(p => p.cities)
      : Object.values(country.provinces).map(p => p.region).filter(Boolean);
    const checkedCount = allRegions.filter(r => checklistState.checkedCodes.has(r.code)).length;
    const totalCount = allRegions.length;
    const visibleRegions = allRegions.filter(r => matchFilter(r, checklistState.checkedCodes.has(r.code)));
    if (visibleRegions.length === 0 && checklistState.searchQuery) return;
    const isExpanded = countryName === '中国' && !checklistState.searchQuery;

    html += `<div class="tree-country${isExpanded ? ' expanded' : ''}" data-country="${escapeHtml(countryName)}">`;
    html += `<div class="tree-country-header">`;
    html += `<svg class="tree-arrow" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="m9 18 6-6-6-6"/></svg>`;
    html += `<span class="tree-flag">${flag}</span>`;
    html += `<span class="tree-country-name">${escapeHtml(countryName)}</span>`;
    html += `<span class="tree-country-count ${checkedCount > 0 ? 'checked' : ''}">${checkedCount}/${totalCount}</span>`;
    html += `</div><div class="tree-cities">`;

    if (country.isChina) {
      const provinces = Object.values(country.provinces).sort((a, b) => a.name.localeCompare(b.name, 'zh-CN'));
      provinces.forEach(prov => {
        const provChecked = prov.cities.filter(c => checklistState.checkedCodes.has(c.code)).length;
        const provTotal = prov.cities.length;
        const visibleCities = prov.cities.filter(c => matchFilter(c, checklistState.checkedCodes.has(c.code)));
        if (checklistState.searchQuery && visibleCities.length === 0) return;
        const provExpanded = checklistState.searchQuery || provChecked > 0;
        html += `<div class="tree-province${provExpanded ? ' expanded' : ''}">`;
        html += `<div class="tree-province-header">`;
        html += `<svg class="tree-arrow" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="m9 18 6-6-6-6"/></svg>`;
        html += `<span class="tree-province-name">${escapeHtml(prov.name)}</span>`;
        html += `<span class="tree-province-count">${provChecked}/${provTotal}</span>`;
        html += `</div><div class="tree-cities">`;
        prov.cities.forEach(city => {
          const isChecked = checklistState.checkedCodes.has(city.code);
          if (!matchFilter(city, isChecked)) return;
          html += renderCityItem(city, isChecked);
        });
        html += `</div></div>`;
      });
    } else {
      const regions = Object.values(country.provinces).map(p => p.region).filter(Boolean).sort((a, b) => a.name.localeCompare(b.name, 'zh-CN'));
      regions.forEach(region => {
        const isChecked = checklistState.checkedCodes.has(region.code);
        if (!matchFilter(region, isChecked)) return;
        html += renderRegionItem(region, isChecked);
      });
    }
    html += `</div></div>`;
  });

  if (html === '') {
    container.innerHTML = '<div class="checklist-empty">未找到匹配的城市</div>';
  } else {
    container.innerHTML = html;
  }
  bindChecklistEvents();
}

function renderCityItem(city, isChecked) {
  const typeLabel = { municipality: '直辖市', prefecture_city: '地级市', city: '城市' }[city.type] || '';
  return `<div class="tree-city${isChecked ? ' checked' : ''}" data-code="${city.code}" data-lat="${city.lat}" data-lng="${city.lng}" data-name="${escapeHtml(city.name)}"><div class="tree-checkbox"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3"><path d="M20 6L9 17l-5-5"/></svg></div><span class="tree-city-name">${escapeHtml(city.name)}</span>${typeLabel ? `<span class="tree-city-type">${typeLabel}</span>` : ''}</div>`;
}

function renderRegionItem(region, isChecked) {
  const typeLabel = { state: '州', province: '省', region: '区' }[region.type] || '';
  return `<div class="tree-region-item${isChecked ? ' checked' : ''}" data-code="${region.code}" data-lat="${region.lat}" data-lng="${region.lng}" data-name="${escapeHtml(region.name)}"><div class="tree-checkbox"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3"><path d="M20 6L9 17l-5-5"/></svg></div><span class="tree-region-name">${escapeHtml(region.name)}</span>${typeLabel ? `<span class="tree-region-type">${typeLabel}</span>` : ''}</div>`;
}

function matchFilter(region, isChecked) {
  if (checklistState.searchQuery) {
    const q = checklistState.searchQuery.toLowerCase();
    const nameMatch = region.name && region.name.toLowerCase().includes(q);
    const provinceMatch = region.province && region.province.toLowerCase().includes(q);
    if (!nameMatch && !provinceMatch) return false;
  }
  if (checklistState.filter === 'checked' && !isChecked) return false;
  if (checklistState.filter === 'unchecked' && isChecked) return false;
  return true;
}

function bindChecklistEvents() {
  document.querySelectorAll('.tree-country-header').forEach(header => {
    header.addEventListener('click', (e) => {
      if (e.target.closest('.tree-city') || e.target.closest('.tree-region-item')) return;
      header.parentElement.classList.toggle('expanded');
    });
  });
  document.querySelectorAll('.tree-province-header').forEach(header => {
    header.addEventListener('click', (e) => {
      if (e.target.closest('.tree-city')) return;
      header.parentElement.classList.toggle('expanded');
    });
  });
  document.querySelectorAll('.tree-city, .tree-region-item').forEach(item => {
    item.addEventListener('click', async (e) => {
      e.stopPropagation();
      await toggleCheckinFromList(item);
    });
  });
}

async function toggleCheckinFromList(item) {
  const code = item.dataset.code;
  const lat = parseFloat(item.dataset.lat);
  const lng = parseFloat(item.dataset.lng);
  const name = item.dataset.name;
  const isChecked = item.classList.contains('checked');
  if (!state.user) { showToast('请先登录', 'error'); return; }
  const region = checklistState.regions.find(r => r.code === code);
  if (!region) return;

  if (isChecked) {
    removeLocalCheckin(code);
    item.classList.remove('checked');
    checklistState.checkedCodes.delete(code);
    state.user.totalCheckins = getLocalCheckins().length;
    saveUser(state.user);
    showToast(`已取消「${name}」`, '');
    syncMapAfterListChange();
    updateChecklistStats();
    updateMapStats();
    updateUserInLeaderboard();
  } else {
    const result = addLocalCheckin({
      region_code: code, region_name: name,
      region_type: region.type || 'city',
      country: region.country || '', province: region.province || '',
      latitude: lat, longitude: lng,
      created_at: new Date().toISOString()
    });
    if (result.success) {
      item.classList.add('checked');
      checklistState.checkedCodes.add(code);
      state.user.totalCheckins = getLocalCheckins().length;
      saveUser(state.user);
      showToast(result.alreadyChecked ? '该区域已打卡' : `打卡成功！「${name}」`, 'success');
      syncMapAfterListChange();
      updateChecklistStats();
      updateMapStats();
      updateUserInLeaderboard();
    }
  }
}

async function syncMapAfterListChange() {
  await loadCheckedMarkers();
}

function updateChecklistStats() {
  const checked = checklistState.checkedCodes.size;
  const total = checklistState.regions.length || 972;
  const percent = total > 0 ? (checked / total) * 100 : 0;
  document.getElementById('checklist-checked-count').textContent = checked;
  document.getElementById('checklist-total-count').textContent = total;
  document.getElementById('checklist-progress-fill').style.width = percent + '%';
}

function setupChecklistSearch() {
  const input = document.getElementById('checklist-search');
  const clearBtn = document.getElementById('checklist-search-clear');
  let searchTimer = null;
  input.addEventListener('input', (e) => {
    const query = e.target.value.trim();
    if (query) { clearBtn.style.display = 'flex'; } else { clearBtn.style.display = 'none'; }
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => { checklistState.searchQuery = query; renderChecklist(); }, 300);
  });
  clearBtn.addEventListener('click', () => {
    input.value = ''; clearBtn.style.display = 'none';
    checklistState.searchQuery = ''; renderChecklist(); input.focus();
  });
  document.querySelectorAll('.filter-chip').forEach(chip => {
    chip.addEventListener('click', () => {
      document.querySelectorAll('.filter-chip').forEach(c => c.classList.remove('active'));
      chip.classList.add('active');
      checklistState.filter = chip.dataset.filter;
      renderChecklist();
    });
  });
}

function refreshChecklistChecked() {
  const checkins = getLocalCheckins();
  checklistState.checkedCodes = new Set(checkins.map(c => c.region_code));
  renderChecklist();
  updateChecklistStats();
}

// ==================== 导航 ====================
function setupNavigation() {
  document.querySelectorAll('.nav-item').forEach(btn => {
    btn.addEventListener('click', () => switchView(btn.dataset.view));
  });
}

function switchView(viewName) {
  document.querySelectorAll('.nav-item').forEach(b => b.classList.remove('active'));
  document.querySelector(`.nav-item[data-view="${viewName}"]`).classList.add('active');
  document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
  document.getElementById(`view-${viewName}`).classList.add('active');
  if (viewName === 'map' && state.map) setTimeout(() => state.map.invalidateSize(), 100);
  if (viewName === 'checklist') {
    if (!checklistState.loaded) loadChecklist(); else refreshChecklistChecked();
  } else if (viewName === 'leaderboard') {
    loadLeaderboard();
  } else if (viewName === 'profile') {
    loadProfile();
  }
}

// ==================== 初始化 ====================
async function init() {
  // 启动时清理旧版边界缓存 (无 isReal 标记 = 旧版/失败数据)
  migrateBoundaryCache();

  initTheme();
  initOrientation();
  initMap();
  setupSearch();
  setupChecklistSearch();
  setupNavigation();

  document.getElementById('theme-toggle').addEventListener('click', toggleTheme);
  document.getElementById('orientation-toggle').addEventListener('click', toggleOrientation);
  document.getElementById('checkin-cancel').addEventListener('click', hideCheckinModal);
  document.getElementById('checkin-confirm').addEventListener('click', confirmCheckin);
  document.getElementById('edit-name-btn').addEventListener('click', showNameModal);
  document.getElementById('name-cancel').addEventListener('click', hideNameModal);
  document.getElementById('name-save').addEventListener('click', saveName);
  document.getElementById('name-input').addEventListener('keydown', (e) => { if (e.key === 'Enter') saveName(); });
  document.getElementById('checkin-modal').addEventListener('click', (e) => { if (e.target.id === 'checkin-modal') hideCheckinModal(); });
  document.getElementById('name-modal').addEventListener('click', (e) => { if (e.target.id === 'name-modal') hideNameModal(); });

  // 预加载区域数据
  loadRegions();

  // 登录
  const user = await ensureLogin();
  if (user) {
    await loadCheckedMarkers();
    // 更新排行榜中的用户数据
    updateUserInLeaderboard();
    setTimeout(() => {
      const hint = document.getElementById('map-hint');
      if (hint) { hint.style.transition = 'opacity 0.5s ease'; hint.style.opacity = '0'; setTimeout(() => hint.style.display = 'none', 500); }
    }, 5000);
  }
}

document.addEventListener('DOMContentLoaded', init);
