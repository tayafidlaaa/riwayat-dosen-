<?php
declare(strict_types=1);

require __DIR__ . '/api.php';

if (isset($_GET['unduh']) && $_GET['unduh'] === 'excel') {
    try {
        unduh_excel_pendidikan();
    } catch (PddiktiException $e) {
        http_response_code($e->getCode() ?: 502);
        header('Content-Type: text/plain; charset=UTF-8');
        echo 'Unduhan gagal: ' . $e->getMessage();
        exit;
    }
}

function h(?string $s): string
{
    return htmlspecialchars((string) $s, ENT_QUOTES | ENT_SUBSTITUTE, 'UTF-8');
}

$q = trim((string) ($_GET['q'] ?? ''));
$id = trim((string) ($_GET['id'] ?? ''));

$view = 'home';
$error = null;
$hasil = [];
$dosen = null;
$pend = [];
$meng = [];
$errPend = null;
$errMeng = null;

try {
    if ($id !== '') {
        $view = 'detail';
        // Pastikan ID dikenal; kalau cache hilang, minta pengguna mencari ulang.
        $dosen = allowed_map()[$id] ?? null;
        if ($dosen === null) {
            $view = 'home';
            $error = 'Sesi pencarian sudah kedaluwarsa. Silakan cari nama dosen kembali.';
        } else {
            try {
                $pend = records_from(detail_dosen('pendidikan', $id));
            } catch (PddiktiException $e) {
                $errPend = $e->getMessage();
            }
            try {
                $meng = records_from(detail_dosen('mengajar', $id));
            } catch (PddiktiException $e) {
                $errMeng = $e->getMessage();
            }
        }
    } elseif ($q !== '') {
        $hasil = cari_dosen($q);
    }
} catch (PddiktiException $e) {
    $error = $e->getMessage();
}

/** Urutkan riwayat pendidikan dari yang terbaru. */
usort($pend, static function (array $a, array $b): int {
    $ya = (int) preg_replace('/\D/', '', normalisasi_pendidikan($a)['tahun']);
    $yb = (int) preg_replace('/\D/', '', normalisasi_pendidikan($b)['tahun']);
    return $yb <=> $ya;
});

/** Cadangan bila nama field tidak dikenali: tampilkan pasangan kunci-nilai skalar. */
function fallback_pairs(array $rec): array
{
    $out = [];
    foreach ($rec as $k => $v) {
        if ((is_string($v) || is_numeric($v)) && trim((string) $v) !== '') {
            $out[ucfirst(str_replace('_', ' ', (string) $k))] = trim((string) $v);
        }
    }
    return $out;
}

/** Ratakan satu tingkat: nilai skalar dipertahankan, array bersarang jadi "induk_anak". */
function flatten_scalars(array $rec): array
{
    $out = [];
    foreach ($rec as $k => $v) {
        if (is_string($v) || is_numeric($v) || is_bool($v)) {
            $out[(string) $k] = is_bool($v) ? ($v ? 'Ya' : 'Tidak') : trim((string) $v);
        } elseif (is_array($v) && !is_list_array($v)) {
            foreach ($v as $k2 => $v2) {
                if (is_string($v2) || is_numeric($v2))
                    $out[$k . '_' . $k2] = trim((string) $v2);
            }
        }
    }
    return $out;
}

function label_kolom(string $key): string
{
    static $map = [
    'nama_mk' => 'Mata kuliah',
    'nama_mata_kuliah' => 'Mata kuliah',
    'mata_kuliah' => 'Mata kuliah',
    'nm_mk' => 'Mata kuliah',
    'nama_matkul' => 'Mata kuliah',
    'matkul' => 'Mata kuliah',
    'kode_mk' => 'Kode',
    'kode_mata_kuliah' => 'Kode',
    'kd_mk' => 'Kode',
    'nama_kelas' => 'Kelas',
    'kelas' => 'Kelas',
    'nm_kls' => 'Kelas',
    'nama_kls' => 'Kelas',
    'nama_prodi' => 'Prodi',
    'prodi' => 'Prodi',
    'program_studi' => 'Prodi',
    'nama_pt' => 'Perguruan tinggi',
    'sks' => 'SKS',
    'sks_mk' => 'SKS',
    'jml_mhs' => 'Mahasiswa',
    'jumlah_mahasiswa' => 'Mahasiswa',
    ];
    return $map[$key] ?? ucfirst(trim(str_replace('_', ' ', $key)));
}

function is_semester_key(string $k): bool
{
    return (bool) preg_match('/semester|(^|_)smt($|_)/i', $k);
}

function looks_like_id(string $v): bool
{
    return (bool) (preg_match('/^[0-9a-f]{8}-[0-9a-f]{4}-/i', $v) || (strlen($v) >= 24 && !str_contains($v, ' ')));
}

/**
 * Susun riwayat mengajar: kelompokkan per semester, kolom ditentukan otomatis dari data.
 * @return array{groups: array<string, list<array<string,string>>>, cols: list<string>}
 */
function susun_mengajar(array $records): array
{
    $rows = array_map('flatten_scalars', $records);

    // Kunci semester (pilih yang nilainya berupa teks seperti "2025/2026 Ganjil" bila ada)
    $semKey = null;
    foreach ($rows as $r) {
        foreach ($r as $k => $v) {
            if (is_semester_key($k) && $v !== '') {
                if ($semKey === null || (preg_match('/[A-Za-z]/', $v) && !preg_match('/[A-Za-z]/', $r[$semKey] ?? '')))
                    $semKey = $k;
            }
        }
        if ($semKey !== null)
            break;
    }

    // Kolom: semua kunci yang punya isi, tanpa kolom semester dan kolom ID teknis
    $cols = [];
    foreach ($rows as $r) {
        foreach ($r as $k => $v) {
            if ($v === '' || is_semester_key($k))
                continue;
            $cols[$k] ??= ['n' => 0, 'id' => 0];
            $cols[$k]['n']++;
            if (looks_like_id($v))
                $cols[$k]['id']++;
        }
    }
    $cols = array_keys(array_filter($cols, static fn(array $c): bool => $c['id'] < $c['n']));

    // Urutan kolom: kode, mata kuliah, kelas, prodi, lalu SKS dan sisanya
    usort($cols, static function (string $a, string $b): int {
        $rank = static function (string $k): int {
            return match (true) {
                stripos($k, 'sks') !== false => 8,
                (bool) preg_match('/jml|jumlah/i', $k) => 9,
                stripos($k, 'kode') !== false || stripos($k, 'kd_') === 0 => 0,
                (bool) preg_match('/mata|matkul|(^|_)mk($|_)/i', $k) => 1,
                (bool) preg_match('/kelas|kls/i', $k) => 2,
                stripos($k, 'prodi') !== false => 3,
                default => 5,
            };
        };
        return $rank($a) <=> $rank($b);
    });

    $groups = [];
    foreach ($rows as $r) {
        $g = $semKey !== null && ($r[$semKey] ?? '') !== '' ? $r[$semKey] : 'Semester tidak diketahui';
        $groups[$g][] = $r;
    }
    return ['groups' => $groups, 'cols' => $cols];
}

$mengSusun = susun_mengajar($meng);
?>
<!doctype html>
<html lang="id">

<head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>Riwayat Dosen PNL<?= $dosen ? ' · ' . h($dosen['nama']) : '' ?></title>
    <link rel="stylesheet" href="assets/css/style.css?v=3">
</head>

<body class="<?= $view === 'detail' ? 'is-detail' : ($q !== '' ? 'is-results' : '') ?>">
    <div class="page">

        <header class="top">
            <a href="./">Politeknik Negeri Lhokseumawe</a>
            <span>Direktori Dosen</span>
        </header>

        <?php if ($view === 'home'): ?>
            <div class="hero">
                <h1>Riwayat pendidikan<br>dosen PNL</h1>
                <p>Telusuri jenjang, kampus, dan tahun kelulusan dosen Politeknik Negeri Lhokseumawe.</p>
            </div>

            <form class="search" method="get" action="">
                <input type="search" name="q" value="<?= h($q) ?>" placeholder="Ketik nama dosen…" minlength="3" required
                    autocomplete="off" <?= $q === '' ? 'autofocus' : '' ?>>
                <button type="submit">Cari</button>
            </form>

            <div class="export-box">
                <div>
                    <strong>Rekap pendidikan seluruh dosen</strong>
                    <p>Unduh rekap semua dosen PNL dengan kolom kampus dan tahun lulus S1, S2, serta S3.</p>
                </div>
                <a class="export-button" href="?unduh=excel">Unduh Excel</a>
            </div>

            <?php if ($error): ?>
                <div class="note"><?= h($error) ?></div>
            <?php elseif ($q !== ''): ?>
                <?php if (!$hasil): ?>
                    <p class="empty" style="margin-top:32px">Tidak ditemukan dosen PNL dengan nama “<?= h($q) ?>”.</p>
                <?php else: ?>
                    <div class="count"><?= count($hasil) ?> dosen ditemukan</div>
                    <ul class="list">
                        <?php foreach ($hasil as $d):
                            $info = array_filter([$d['nama_prodi'], $d['nidn'] !== '' ? 'NIDN ' . $d['nidn'] : '']); ?>
                            <li>
                                <a href="?id=<?= urlencode($d['id']) ?>">
                                    <span>
                                        <div class="nama"><?= h($d['nama']) ?></div>
                                        <?php if ($info): ?>
                                            <div class="info"><?= h(implode(' · ', $info)) ?></div><?php endif; ?>
                                    </span>
                                    <span class="arrow">→</span>
                                </a>
                            </li>
                        <?php endforeach; ?>
                    </ul>
                <?php endif; ?>
            <?php endif; ?>

        <?php else: ?>
            <a class="back" href="javascript:history.back()">← Kembali</a>

            <div class="profile">
                <h1><?= h($dosen['nama']) ?></h1>
                <div class="facts">
                    <?php if ($dosen['nama_prodi'] !== ''): ?><span><b><?= h($dosen['nama_prodi']) ?></b></span><?php endif; ?>
                    <?php if ($dosen['nidn'] !== ''): ?><span>NIDN <b><?= h($dosen['nidn']) ?></b></span><?php endif; ?>
                    <?php if ($dosen['nuptk'] !== ''): ?><span>NUPTK <b><?= h($dosen['nuptk']) ?></b></span><?php endif; ?>
                </div>
            </div>

            <section class="block">
                <h2>Riwayat pendidikan</h2>
                <?php if ($errPend): ?>
                    <div class="note"><?= h($errPend) ?></div>
                <?php elseif (!$pend): ?>
                    <p class="empty">Belum ada data riwayat pendidikan.</p>
                <?php else: ?>
                    <ol class="timeline">
                        <?php foreach ($pend as $rec):
                            $p = normalisasi_pendidikan($rec); ?>
                            <li>
                                <?php if (!array_filter($p)): ?>
                                    <dl class="kv"><?php foreach (fallback_pairs($rec) as $k => $v): ?>
                                            <dt><?= h($k) ?></dt>
                                            <dd><?= h($v) ?></dd>
                                        <?php endforeach; ?>
                                    </dl>
                                <?php else: ?>
                                    <?php if ($p['tahun'] !== ''): ?>
                                        <div class="year"><?= h($p['tahun']) ?></div><?php endif; ?>
                                    <div class="jenjang"><?= h($p['jenjang'] ?: 'Pendidikan') ?>
                                        <?php if ($p['gelar'] !== ''): ?><small>· <?= h($p['gelar']) ?></small><?php endif; ?>
                                    </div>
                                    <?php if ($p['pt'] !== ''): ?>
                                        <div class="pt"><?= h($p['pt']) ?></div><?php endif; ?>
                                    <?php if ($p['bidang'] !== ''): ?>
                                        <div class="bidang"><?= h($p['bidang']) ?></div><?php endif; ?>
                                <?php endif; ?>
                            </li>
                        <?php endforeach; ?>
                    </ol>
                <?php endif; ?>
            </section>

            <section class="block">
                <h2>Riwayat mengajar <?php if ($meng): ?><span class="badge"><?= count($meng) ?> kelas</span><?php endif; ?>
                </h2>
                <?php if ($errMeng): ?>
                    <div class="note"><?= h($errMeng) ?></div>
                <?php elseif (!$meng): ?>
                    <p class="empty">Belum ada data riwayat mengajar.</p>
                <?php elseif (!$mengSusun['cols']): ?>
                    <p class="empty">Data mengajar diterima, tetapi tidak ada kolom yang dapat ditampilkan.</p>
                <?php else: ?>
                    <?php foreach ($mengSusun['groups'] as $sem => $baris): ?>
                        <div class="semester">
                            <h3><?= h((string) $sem) ?> <span class="badge"><?= count($baris) ?></span></h3>
                            <div class="scroll">
                                <table class="mk">
                                    <thead>
                                        <tr>
                                            <?php foreach ($mengSusun['cols'] as $c): ?>
                                                <th<?= preg_match('/sks|jml|jumlah/i', $c) ? ' class="num"' : '' ?>>
                                                    <?= h(label_kolom($c)) ?></th>
                                                <?php endforeach; ?>
                                        </tr>
                                    </thead>
                                    <tbody>
                                        <?php foreach ($baris as $r): ?>
                                            <tr>
                                                <?php foreach ($mengSusun['cols'] as $c):
                                                    $v = $r[$c] ?? ''; ?>
                                                    <td<?= preg_match('/sks|jml|jumlah/i', $c) ? ' class="num"' : '' ?>>
                                                        <?= $v !== '' ? h($v) : '<span class="empty">—</span>' ?></td>
                                                    <?php endforeach; ?>
                                            </tr>
                                        <?php endforeach; ?>
                                    </tbody>
                                </table>
                            </div>
                        </div>
                    <?php endforeach; ?>
                <?php endif; ?>
                <?php if (isset($_GET['raw'])): ?>
                    <details class="raw" open>
                        <summary>Data mentah (3 baris pertama)</summary>
                        <pre><?= h(json_encode(array_slice($meng, 0, 3), JSON_PRETTY_PRINT | JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES)) ?></pre>
                    </details>
                <?php endif; ?>
            </section>
        <?php endif; ?>

        <footer>Sumber: situs PDDikti. Data dapat berbeda dengan arsip kepegawaian kampus.</footer>
    </div>
    <script src="assets/js/script.js" defer></script>
</body>

</html>
