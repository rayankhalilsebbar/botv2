// config.js
module.exports = {
  // Paramètres de trading
  symbol: 'BTCUSDT',
  maxOrders: 100,           // Nombre maximum d'ordres actifs
  priceStep: 10,            // Écart entre les paliers en USD
  orderAmountUSDT: 2,      // Montant fixe en USDT pour chaque ordre
  pricePrecision: 2,        // Nombre de décimales pour les prix
  sizePrecision: 6,         // Nombre de décimales pour la taille des ordres
  
  // Paramètres WebSocket
  wsEndpoints: {
    public: 'wss://ws.bitget.com/v2/ws/public',
    private: 'wss://ws.bitget.com/v2/ws/private'
  },
  
  // Paramètres d'authentification
  apiKeys: {
    apiKey: process.env.BITGET_API_KEY || 'METTRE API KEY',
    secretKey: process.env.BITGET_SECRET_KEY || 'METTRE SECRET KEY',
    passphrase: process.env.BITGET_PASSPHRASE || 'METTRE PASSPHRASE'
  },
  
  // Paramètres pour les ordres en masse
  batchProcessing: {
    maxBatchSize: 49,          // Taille maximale d'un lot (limite BitGet)
    batchInterval: 1001,       // Intervalle entre les lots en ms
    priorityOrder: ['cancel', 'sell', 'buy'] // Priorité d'exécution des ordres
  },
  
  // Paramètres de la stratégie
  strategy: {
    updateInterval: 1000,      // Intervalle de mise à jour de la grille en ms
  },
  
  // Paramètres WebSocket
  pingInterval: 30000,         // Intervalle de ping/pong en ms
}; 