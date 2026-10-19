const API_ROOT = 'https://pddikti.kemdiktisaintek.go.id/api';

const PDDIKTI_HEADERS = {
  'Accept': 'application/json',
  'Content-Type': 'application/json',
  'Origin': 'https://pddikti.kemdiktisaintek.go.id',
  'Referer': 'https://pddikti.kemdiktisaintek.go.id/',
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36'
};

let cachedPnlList = null;
let lastCacheTime = 0;

async function getPnlList() {
  const now = Date.now();
  if (cachedPnlList && (now - lastCacheTime < 3600000)) return cachedPnlList;
  try {
    const resp = await fetch('https://data.pnl.ac.id/dosen/list', {
      headers: {
        'Accept': 'text/html,application/xhtml+xml',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
      }
    });
    if (!resp.ok) return cachedPnlList || [];
    const html = await resp.text();
    const trRegex = /<tr[\s\S]*?<\/tr>/gi;
    const matches = html.match(trRegex) || [];
    const rows = [];
    for (const tr of matches) {
      const tdMatches = [...tr.matchAll(/<td[\s\S]*?>([\s\S]*?)<\/td>/gi)];
      if (tdMatches.length >= 11) {
        const clean = tdMatches.map(m => m[1].replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim());
        if (/^\d+$/.test(clean[0])) {
          rows.push({
            no: clean[0],
            nama: clean[1],
            nidn: clean[2] || '',
            nuptk: clean[3] || '',
            prodi: clean[8] || '',
            jurusan: clean[9] || ''
          });
        }
      }
    }
    if (rows.length > 0) {
      cachedPnlList = rows;
      lastCacheTime = now;
    }
    return cachedPnlList || [];
  } catch (_) {
    return cachedPnlList || [];
  }
}

function extractRecords(v, depth = 0) {
  if (depth > 6 || !v || typeof v !== 'object') return [];
  if (Array.isArray(v)) {
    return v.filter(item => item && typeof item === 'object');
  }
  for (const k of ['dosen', 'data', 'results', 'result', 'items', 'records', 'content']) {
    if (k in v) {
      const res = extractRecords(v[k], depth + 1);
      if (res.length > 0) return res;
    }
  }
  return [];
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  let id = (req.query?.id || '').trim();
  let nidn = (req.query?.nidn || '').trim();
  let nama = (req.query?.nama || '').trim();

  if (!id && !nidn && !nama) {
    return res.status(400).json({ error: 'Parameter dosen harus disertakan.' });
  }

  // Jika ID adalah hash PDDikti langsung (panjang dan ada karakter '=')
  let pddiktiId = (id.includes('=') && !id.startsWith('nidn_') && !id.startsWith('nama_')) ? id : null;

  // Jika belum berupa hash PDDikti: cari nama dosen dari daftar PNL
  if (!pddiktiId) {
    if (id.startsWith('nidn_')) nidn = id.replace('nidn_', '');
    if (id.startsWith('nama_')) nama = decodeURIComponent(id.replace('nama_', ''));

    // Jika belum ada nama tapi ada NIDN, cari nama lengkap dari portal data PNL
    if (!nama && nidn) {
      const pnl = await getPnlList();
      const found = pnl.find(d => d.nidn === nidn);
      if (found && found.nama) {
        nama = found.nama;
      }
    }

    // Cari ke PDDikti dengan NAMA LENGKAP dosen (paling akurat)
    if (nama) {
      try {
        const u = `${API_ROOT}/pencarian/dosen/${encodeURIComponent(nama)}`;
        const searchResp = await fetch(u, { headers: PDDIKTI_HEADERS });
        if (searchResp.ok) {
          const searchJson = await searchResp.json();
          const records = extractRecords(searchJson);
          const match = records.find(r => 
            (nidn && r.nidn === nidn) || 
            (r.nama_pt && (r.nama_pt.toLowerCase().includes('lhokseumawe') || r.nama_pt.toLowerCase().includes('pnl'))) ||
            (r.nama && r.nama.toLowerCase().trim() === nama.toLowerCase().trim())
          );
          if (match && (match.id || match.id_sdm)) {
            pddiktiId = match.id || match.id_sdm;
          }
        }
      } catch (_) {}
    }

    // Jika belum ketemu, coba cari berdasarkan NIDN langsung ke PDDikti
    if (!pddiktiId && nidn) {
      try {
        const u = `${API_ROOT}/pencarian/dosen/${encodeURIComponent(nidn)}`;
        const searchResp = await fetch(u, { headers: PDDIKTI_HEADERS });
        if (searchResp.ok) {
          const searchJson = await searchResp.json();
          const records = extractRecords(searchJson);
          const match = records.find(r => r.nidn === nidn);
          if (match && (match.id || match.id_sdm)) {
            pddiktiId = match.id || match.id_sdm;
          }
        }
      } catch (_) {}
    }
  }

  // Jika tetap tidak ditemukan di PDDikti
  if (!pddiktiId) {
    return res.status(200).json({
      success: true,
      pendidikan: [],
      mengajar: {},
      total_mengajar: 0,
      note: 'Dosen ini belum memiliki riwayat tercatat di PDDikti.'
    });
  }

  try {
    const [studyRes, teachRes] = await Promise.all([
      fetch(`${API_ROOT}/dosen/study-history`, {
        method: 'POST',
        headers: PDDIKTI_HEADERS,
        body: JSON.stringify({ id: pddiktiId })
      }),
      fetch(`${API_ROOT}/dosen/teaching-history`, {
        method: 'POST',
        headers: PDDIKTI_HEADERS,
        body: JSON.stringify({ id: pddiktiId })
      })
    ]);

    const studyJson = studyRes.ok ? await studyRes.json() : null;
    const teachJson = teachRes.ok ? await teachRes.json() : null;

    const rawPend = extractRecords(studyJson);
    const rawMeng = extractRecords(teachJson);

    // Normalize pendidikan
    const pend = rawPend.map(rec => ({
      jenjang: (rec.jenjang || rec.nama_jenjang_didik || rec.jenjang_pendidikan || '').trim(),
      gelar: (rec.gelar_akademik || rec.singkatan_gelar || rec.gelar || '').trim(),
      bidang: (rec.nama_prodi || rec.bidang || rec.bidang_studi || rec.prodi || '').trim(),
      pt: (rec.nama_pt || rec.perguruan_tinggi || '').trim(),
      tahun: String(rec.tahun_lulus || rec.tahun || rec.tgl_lulus || rec.tahun_masuk || '').trim()
    })).sort((a, b) => {
      const ya = parseInt(a.tahun.replace(/\D/g, '')) || 0;
      const yb = parseInt(b.tahun.replace(/\D/g, '')) || 0;
      return yb - ya;
    });

    // Normalize and group mengajar
    const groups = {};
    for (const r of rawMeng) {
      const semester = (r.nama_semester || r.semester || r.id_smt || 'Semester tidak diketahui').trim();
      if (!groups[semester]) groups[semester] = [];

      groups[semester].push({
        kode_mk: (r.kode_matkul || r.kode_mk || r.kode_mata_kuliah || r.kd_mk || '').trim(),
        mata_kuliah: (r.nama_matkul || r.nama_mk || r.nama_mata_kuliah || r.matkul || '').trim(),
        kelas: (r.nama_kelas || r.kelas || r.nm_kls || '').trim(),
        prodi: (r.nama_prodi || r.prodi || '').trim(),
        sks: String(r.sks_mk || r.sks || '').trim(),
        jml_mhs: String(r.jumlah_mahasiswa || r.jml_mhs || '').trim(),
        pt: (r.nama_pt || '').trim()
      });
    }

    res.setHeader('Cache-Control', 's-maxage=86400, stale-while-revalidate=604800');
    return res.status(200).json({
      success: true,
      pendidikan: pend,
      mengajar: groups,
      total_mengajar: rawMeng.length
    });
  } catch (e) {
    return res.status(200).json({
      success: true,
      pendidikan: [],
      mengajar: {},
      total_mengajar: 0,
      note: 'Riwayat detail PDDikti gagal dimuat: ' + e.message
    });
  }
}
