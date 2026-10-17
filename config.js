// 公開する人が一度だけ設定するファイル。手順は README.md を参照。
window.FC_CONFIG = {
  // Google Cloud で作った「OAuth 2.0 クライアント ID」（ウェブ アプリケーション）。
  // 例: "123456789012-abcdefghijklmnopqrstuvwxyz123456.apps.googleusercontent.com"
  clientId: "294352991487-hvi3niu5hminp5lqle5ap1m3q3kjcmjo.apps.googleusercontent.com",

  // true にすると、選んだ日を Google ドライブのアプリ専用領域にも保存し、
  // スマホと PC で同じ状態になる（Google Drive API を有効にしておくこと）。
  // false なら各端末のブラウザにだけ保存する。
  driveSync: true,

  // 新しい月を開いたときの目標回数の初期値。
  defaultTarget: 20,
};
