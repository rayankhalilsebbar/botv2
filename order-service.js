// order-service.js
class OrderService {
  constructor(config, wsClient) {
    this.config = config;
    this.wsClient = wsClient;
    
    // Suivi des ordres actifs
    this.activeBuyOrders = new Map(); // clientOid -> order details
    this.activeSellOrders = new Map(); // clientOid -> order details
    
    // Configurer les écouteurs d'événements
    this.setupEventListeners();
  }
  
  setupEventListeners() {
    // Écouteur pour les ordres d'achat remplis
    this.wsClient.on('buy_order_filled', (data) => {
      this.handleBuyOrderFilled(data);
    });
    
    // Écouteur pour les ordres de vente remplis
    this.wsClient.on('sell_order_filled', (data) => {
      this.handleSellOrderFilled(data);
    });
    
    // Écouteur pour les ordres annulés
    this.wsClient.on('order_cancelled', (data) => {
      this.handleOrderCancelled(data);
    });
  }
  
  // Placement d'un seul ordre
  placeOrder(side, price, size) {
    const clientOid = `${side}_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`;
    
    const orderMessage = {
      op: 'trade',
      args: [
        {
          id: `trade-${Date.now()}`,
          instType: 'SPOT',
          instId: this.config.symbol,
          channel: 'place-order',
          params: {
            orderType: 'limit',
            side: side,
            size: size.toString(),
            price: price.toString(),
            force: 'post_only',
            clientOid: clientOid
          }
        }
      ]
    };
    
    // Ajouter l'ordre à notre suivi local
    if (side === 'buy') {
      this.activeBuyOrders.set(clientOid, {
        clientOid,
        price,
        size,
        side,
        status: 'pending',
        timestamp: Date.now()
      });
    } else if (side === 'sell') {
      this.activeSellOrders.set(clientOid, {
        clientOid,
        price,
        size,
        side,
        status: 'pending',
        timestamp: Date.now()
      });
    }
    
    // Ajouter le message à la file d'attente
    this.wsClient.queueMessage(orderMessage, side);
    
    console.log(`📝 Ordre ${side} ajouté à la file: ${clientOid} à ${price}$ pour ${size} BTC`);
    
    return clientOid;
  }
  
  // Annulation d'un seul ordre
  cancelOrder(clientOid) {
    const cancelMessage = {
      op: 'trade',
      args: [
        {
          id: `cancel-${Date.now()}`,
          instType: 'SPOT',
          instId: this.config.symbol,
          channel: 'cancel-order',
          params: {
            clientOid: clientOid
          }
        }
      ]
    };
    
    // Ajouter le message à la file d'attente avec priorité "cancel"
    this.wsClient.queueMessage(cancelMessage, 'cancel');
    
    console.log(`❌ Annulation de l'ordre ${clientOid} ajoutée à la file`);
    
    return true;
  }
  
  // Placement de plusieurs ordres
  placeBulkOrders(ordersData, side) {
    const results = [];
    
    for (const { price, size } of ordersData) {
      const clientOid = this.placeOrder(side, price, size);
      results.push({ clientOid, price, size });
    }
    
    console.log(`📦 ${results.length} ordres ${side} ajoutés à la file d'attente`);
    
    return results;
  }
  
  // Annulation de plusieurs ordres
  cancelBulkOrders(clientOids) {
    for (const clientOid of clientOids) {
      this.cancelOrder(clientOid);
    }
    
    console.log(`🧹 ${clientOids.length} annulations ajoutées à la file d'attente`);
    
    return clientOids.length;
  }
  
  // Calculer la taille d'un ordre en BTC basée sur le montant en USDT
  calculateOrderSize(price) {
    // Montant en BTC = Montant en USDT / Prix BTC
    const rawSize = this.config.orderAmountUSDT / price;
    
    // Appliquer la précision définie dans la configuration
    const precision = this.config.sizePrecision || 6;
    const formattedSize = parseFloat(rawSize.toFixed(precision));
    
    return formattedSize;
  }
  
  // Gestion des événements d'ordres
  
  handleBuyOrderFilled(data) {
    const { clientOid, price, size } = data;
    
    console.log(`✅ Ordre d'achat ${clientOid} exécuté à ${price}$ pour ${size} BTC`);
    
    // Retirer de la liste des ordres d'achat actifs
    this.activeBuyOrders.delete(clientOid);
    
    // Calculer le prix de vente (prix d'achat + palier)
    const sellPrice = parseFloat((price + this.config.priceStep).toFixed(this.config.pricePrecision));
    
    // Placer l'ordre de vente correspondant
    this.placeOrder('sell', sellPrice, size);
    
    // Émettre notre propre événement pour la stratégie
    this.wsClient.emit('strategy_buy_filled', { clientOid, price, size, sellPrice });
  }
  
  handleSellOrderFilled(data) {
    const { clientOid, price, size } = data;
    
    console.log(`✅ Ordre de vente ${clientOid} exécuté à ${price}$ pour ${size} BTC`);
    
    // Retirer de la liste des ordres de vente actifs
    this.activeSellOrders.delete(clientOid);
    
    // Émettre notre propre événement pour la stratégie, mais sans placer de nouvel ordre
    this.wsClient.emit('strategy_sell_filled', { 
      clientOid, 
      price, 
      size
    });
  }
  
  handleOrderCancelled(data) {
    const { clientOid, side } = data;
    
    console.log(`🚫 Ordre ${clientOid} annulé`);
    
    // Retirer l'ordre des listes actives
    if (side === 'buy') {
      this.activeBuyOrders.delete(clientOid);
    } else if (side === 'sell') {
      this.activeSellOrders.delete(clientOid);
    }
  }
  
  // Obtenir tous les ordres d'achat actifs
  getActiveBuyOrders() {
    return Array.from(this.activeBuyOrders.values());
  }
  
  // Obtenir tous les ordres de vente actifs
  getActiveSellOrders() {
    return Array.from(this.activeSellOrders.values());
  }
  
  // Obtenir tous les ordres actifs
  getAllActiveOrders() {
    return [...this.getActiveBuyOrders(), ...this.getActiveSellOrders()];
  }
  
  // Trouver les ordres d'achat à un certain prix
  getBuyOrderAtPrice(price) {
    for (const order of this.activeBuyOrders.values()) {
      if (order.price === price) {
        return order;
      }
    }
    return null;
  }
  
  // Vérifier si un prix a déjà un ordre d'achat actif
  hasBuyOrderAtPrice(price) {
    return this.getBuyOrderAtPrice(price) !== null;
  }
  
  // Trouver les ordres de vente à un certain prix
  getSellOrderAtPrice(price) {
    for (const order of this.activeSellOrders.values()) {
      if (order.price === price) {
        return order;
      }
    }
    return null;
  }
  
  // Vérifier si un prix a déjà un ordre de vente actif
  hasSellOrderAtPrice(price) {
    return this.getSellOrderAtPrice(price) !== null;
  }
}

module.exports = OrderService; 