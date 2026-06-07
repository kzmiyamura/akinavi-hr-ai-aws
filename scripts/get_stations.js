import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

// スクリプト自身が存在するフォルダの絶対パスを取得
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// 同じフォルダ内にあるCSVファイルを絶対パスで指定
const INPUT_FILE = path.join(__dirname, 'station20251015free.csv');

const PREF_MAP = {
    "1": "北海道", "2": "青森県", "3": "岩手県", "4": "宮城県", "5": "秋田県", "6": "山形県", "7": "福島県",
    "8": "茨城県", "9": "栃木県", "10": "群馬県", "11": "埼玉県", "12": "千葉県", "13": "東京都", "14": "神奈川県",
    "15": "新潟県", "16": "富山県", "17": "石川県", "18": "福井県", "19": "山梨県", "20": "長野県", "21": "岐阜県",
    "22": "静岡県", "23": "愛知県", "24": "三重県", "25": "滋賀県", "26": "京都府", "27": "大阪府", "28": "兵庫県",
    "29": "奈良県", "30": "和歌山県", "31": "鳥取県", "32": "島根県", "33": "岡山県", "34": "広島県", "35": "山口県",
    "36": "徳島県", "37": "香川県", "38": "愛媛県", "39": "高知県", "40": "福岡県", "41": "佐賀県", "42": "長崎県",
    "43": "熊本県", "44": "大分県", "45": "宮崎県", "46": "鹿児島県", "47": "沖縄県"
};

// CSVの1行を正しく分割（カンマ・クォーテーション対応）
function parseCSVLine(line) {
    const result = [];
    let current = '';
    let inQuotes = false;

    for (let i = 0; i < line.length; i++) {
        const char = line[i];
        if (char === '"') {
            inQuotes = !inQuotes;
        } else if (char === ',' && !inQuotes) {
            result.push(current.trim());
            current = '';
        } else {
            current += char;
        }
    }
    result.push(current.trim());
    return result;
}

function processLocalStationCSV() {
    console.log(`ローカルファイルから読み込み中...\nパス: ${INPUT_FILE}`);
    
    try {
        // ファイルの存在チェック
        if (!fs.existsSync(INPUT_FILE)) {
            throw new Error(`入力ファイルが見つかりません。\n[scripts] フォルダの中に "station20251015free.csv" を配置してください。`);
        }

        const csvText = fs.readFileSync(INPUT_FILE, 'utf-8');
        console.log("データを解析中...");

        const lines = csvText.split(/\r?\n/);
        if (lines.length < 2) {
            throw new Error("CSVデータが空か、または正しく読み込めませんでした。");
        }

        // ヘッダーのインデックス取得
        const headers = parseCSVLine(lines[0]);
        const stationNameIdx = headers.indexOf('station_name');
        const prefCdIdx = headers.indexOf('pref_cd');

        if (stationNameIdx === -1 || prefCdIdx === -1) {
            throw new Error("CSVのヘッダー列（station_name, pref_cd）が見つかりません。");
        }

        const seen = new Set();
        const stationList = [];

        // データ行を処理
        for (let i = 1; i < lines.length; i++) {
            if (!lines[i].trim()) continue;

            const columns = parseCSVLine(lines[i]);
            const stationName = columns[stationNameIdx];
            const prefCd = columns[prefCdIdx];
            const prefName = PREF_MAP[parseInt(prefCd, 10)];

            if (!stationName || !prefName) continue;

            // 同一都道府県内の同名駅の重複を排除
            const uniqueKey = `${stationName}-${prefName}`;
            if (!seen.has(uniqueKey)) {
                seen.add(uniqueKey);
                stationList.push({ stationName, prefName });
            }
        }

        // 都道府県順 → 駅名順でソート
        stationList.sort((a, b) => {
            if (a.prefName !== b.prefName) {
                return a.prefName.localeCompare(b.prefName, 'ja');
            }
            return a.stationName.localeCompare(b.stationName, 'ja');
        });

        // 出力用CSVの組み立て
        let outputCsv = "駅名,都道府県\n";
        stationList.forEach(item => {
            outputCsv += `${item.stationName},${item.prefName}\n`;
        });

        // Excel文字化け対策 (BOM付与)
        const bom = Buffer.from([0xEF, 0xBB, 0xBF]);
        const csvBuffer = Buffer.concat([bom, Buffer.from(outputCsv, 'utf-8')]);

        // 出力先もスクリプトと同じフォルダにする場合は path.join(__dirname, '...') にしてください
        // 今回はプロジェクトのルート直下に出す想定でそのままにしています
        const outputFilename = "japan_all_stations_js.csv";
        fs.writeFileSync(outputFilename, csvBuffer);

        console.log(`\n✨ 完了しました！ [${outputFilename}] に保存されました。`);
        console.log(`📊 出力された総駅数（重複排除後）: ${stationList.length} 駅`);

    } catch (error) {
        console.error("\n--- エラー詳細 ---");
        console.error(error.message);
        console.error("------------------\n");
    }
}

processLocalStationCSV();