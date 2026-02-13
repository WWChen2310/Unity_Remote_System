module.exports = {
  apps: [{
    name: 'unity-control-server',
    script: './integrated-server.js',
    
    // 指定工作目錄（改為你的專案路徑）
    cwd: 'C:/BitoStudio/repositories/Unity_Remote_System',
    
    // 自動重啟設定
    watch: false,
    autorestart: true,
    max_restarts: 10,
    min_uptime: '10s',
    
    // 錯誤處理
    error_file: './logs/err.log',
    out_file: './logs/out.log',
    log_date_format: 'YYYY-MM-DD HH:mm:ss Z',
    
    // 環境變數
    env: {
      NODE_ENV: 'production',
      PORT: 3000
    },
    
    // 開發環境
    env_development: {
      NODE_ENV: 'development',
      PORT: 3000
    }
  }]
};