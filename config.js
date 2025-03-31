// config.js
module.exports = {
  // Paramètres de trading
  symbol: 'BTCUSDT',
  maxOrders: 10,           // Nombre maximum d'ordres actifs
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
    apiKey: process.env.BITGET_API_KEY || 'METTRE LA CLE API  ',
    secretKey: process.env.BITGET_SECRET_KEY || 'METTRE LA CLE SECRET',
    passphrase: process.env.BITGET_PASSPHRASE || 'METTRE LE PASSPHRASE'
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
  pingInterval: 29000,         // Intervalle de ping/pong en ms
  reconnectInterval: 85800000, // Intervalle de reconnexion programmée (23h50m)
}; 
