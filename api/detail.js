const API_ROOT = 'https://pddikti.kemdiktisaintek.go.id/api';

const PDDIKTI_HEADERS = {
  'Accept': 'application/json',
  'Content-Type': 'application/json',
  'Origin': 'https://pddikti.kemdiktisaintek.go.id',
  'Referer': 'https://pddikti.kemdiktisaintek.go.id/',
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36'
};

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
  const nidnParam = (req.query?.nidn || '').trim();
  const namaParam = (req.query?.nama || '').trim();

  if (!id && !nidnParam && !namaParam) {
    return res.status(400).json({ error: 'Parameter dosen harus disertakan.' });
  }

  let pddiktiId = (id.includes('=') && !id.startsWith('nidn_') && !id.startsWith('nama_')) ? id : null;

  // Resolusi ID jika belum berupa hash PDDikti
  if (!pddiktiId) {
    // 1. Cari berdasarkan NAMA dosen (Paling akurat di PDDikti untuk mencocokkan dosen PNL)
    const nameToSearch = namaParam || (id.startsWith('nama_') ? decodeURIComponent(id.replace('nama_', '')) : '');
    const nidnToMatch = nidnParam || (id.startsWith('nidn_') ? id.replace('nidn_', '') : '');

    if (nameToSearch) {
      try {
        const searchResp = await fetch(`${API_ROOT}/pencarian/dosen/${encodeURIComponent(nameToSearch)}`, {
          headers: PDDIKTI_HEADERS
        });
        if (searchResp.ok) {
          const searchJson = await searchResp.json();
          const records = extractRecords(searchJson);
          const match = records.find(r => 
            (nidnToMatch && r.nidn === nidnToMatch) || 
            (r.nama_pt && (r.nama_pt.toLowerCase().includes('lhokseumawe') || r.nama_pt.toLowerCase().includes('pnl'))) ||
            (r.nama && r.nama.toLowerCase().trim() === nameToSearch.toLowerCase().trim())
          );
          if (match && (match.id || match.id_sdm)) {
            pddiktiId = match.id || match.id_sdm;
          }
        }
      } catch (_) {}
    }

    // 2. Jika nama belum ketemu, coba cari berdasarkan NIDN
    if (!pddiktiId && nidnToMatch) {
      try {
        const searchResp = await fetch(`${API_ROOT}/pencarian/dosen/${encodeURIComponent(nidnToMatch)}`, {
          headers: PDDIKTI_HEADERS
        });
        if (searchResp.ok) {
          const searchJson = await searchResp.json();
          const records = extractRecords(searchJson);
          const match = records.find(r => r.nidn === nidnToMatch);
          if (match && (match.id || match.id_sdm)) {
            pddiktiId = match.id || match.id_sdm;
          }
        }
      } catch (_) {}
    }
  }

  if (!pddiktiId) {
    return res.status(200).json({
      success: true,
      pendidikan: [],
      mengajar: {},
      total_mengajar: 0,
      note: 'Riwayat detail PDDikti belum tersedia untuk dosen ini.'
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
