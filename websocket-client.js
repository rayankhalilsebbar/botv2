// websocket-client.js
const WebSocket = require('ws');
const crypto = require('crypto');
const EventEmitter = require('events');

class WebSocketClient extends EventEmitter {
  constructor(config) {
    super();
    this.config = config;
    this.publicWs = null;
    this.privateWs = null;
    this.publicConnected = false;
    this.privateConnected = false;
    this.isAuthenticated = false;
    this.currentPrice = null;
    
    // Files d'attente pour les messages
    this.messageQueue = {
      cancel: [],
      sell: [],
      buy: []
    };
    this.processingQueue = false;
    this.batchInterval = null;
    
    // Intervalles pour les pings
    this.publicPingInterval = null;
    this.privatePingInterval = null;
  }
  
  async connect() {
    try {
      await Promise.all([
        this.connectPublic(),
        this.connectPrivate()
      ]);
      
      // Démarrer le traitement par lots
      this.startBatchProcessing();
      
      return true;
    } catch (error) {
      console.error('❌ Erreur lors de la connexion aux WebSockets:', error);
      return false;
    }
  }
  
  async connectPublic() {
    return new Promise((resolve, reject) => {
      console.log(`🔌 Connexion au WebSocket public: ${this.config.wsEndpoints.public}`);
      
      this.publicWs = new WebSocket(this.config.wsEndpoints.public);
      
      this.publicWs.on('open', () => {
        console.log('✅ WebSocket public connecté');
        this.publicConnected = true;
        
        // S'abonner au canal ticker
        this.subscribeToPriceUpdates();
        
        // Configurer le ping/pong
        this.setupPublicPingPong();
        
        resolve();
      });
      
      this.publicWs.on('message', (message) => {
        try {
          // Traiter le ping/pong en texte brut
          if (message.toString() === 'pong') {
            return;
          }
          
          const data = JSON.parse(message.toString());
          
          // Traiter les mises à jour de prix
          if (data.arg && data.arg.channel === 'ticker' && data.data && data.data.length > 0) {
            const price = parseFloat(data.data[0].lastPr);
            
            if (isNaN(price)) {
              console.error('❌ Prix invalide reçu:', data.data[0]);
              return;
            }
            
            this.currentPrice = price;
            this.emit('price_update', price);
          }
        } catch (error) {
          console.error('❌ Erreur de traitement du message public:', error.message);
        }
      });
      
      this.publicWs.on('error', (error) => {
        console.error(`❌ Erreur WebSocket public: ${error.message}`);
        this.publicConnected = false;
        reject(error);
      });
      
      this.publicWs.on('close', () => {
        console.warn(`⚠️ WebSocket public déconnecté`);
        this.publicConnected = false;
        
        // Nettoyer les intervalles
        if (this.publicPingInterval) {
          clearInterval(this.publicPingInterval);
          this.publicPingInterval = null;
        }
      });
    });
  }
  
  async connectPrivate() {
    return new Promise((resolve, reject) => {
      console.log(`🔌 Connexion au WebSocket privé: ${this.config.wsEndpoints.private}`);
      
      this.privateWs = new WebSocket(this.config.wsEndpoints.private);
      
      this.privateWs.on('open', () => {
        console.log('✅ WebSocket privé connecté');
        this.privateConnected = true;
        
        // S'authentifier
        this.authenticate();
        
        // Configurer le ping/pong
        this.setupPrivatePingPong();
        
        resolve();
      });
      
      this.privateWs.on('message', (message) => {
        try {
          // Traiter le ping/pong en texte brut
          if (message.toString() === 'pong') {
            return;
          }
          
          const data = JSON.parse(message.toString());
          
          // Traiter l'événement de login
          if (data.event === 'login') {
            if (data.code === 0 || data.code === '0') {
              console.log('🔐 Authentification réussie');
              this.isAuthenticated = true;
              this.subscribeToOrderUpdates();
            } else {
              console.error(`❌ Échec de l'authentification: ${data.msg}`);
            }
            return;
          }
          
          // Traiter les mises à jour d'ordres
          if (data.arg && data.arg.channel === 'orders' && data.data && data.data.length > 0) {
            data.data.forEach(order => {
              const { clientOid, status, price, newSize, side } = order;
              
              if (!clientOid) {
                console.log('📋 Ordre sans clientOid reçu:', order);
                return;
              }
              
              console.log(`📋 Mise à jour d'ordre: ${clientOid}, Statut: ${status}`);
              
              // Traiter différents types de statuts
              if (status === 'filled') {
                // Toujours utiliser newSize pour les ordres exécutés
                const size = parseFloat(newSize);
                
                // Déterminer s'il s'agit d'un achat ou d'une vente
                if (clientOid.startsWith('buy_')) {
                  this.emit('buy_order_filled', {
                    clientOid,
                    price: parseFloat(price),
                    size: size
                  });
                } else if (clientOid.startsWith('sell_')) {
                  this.emit('sell_order_filled', {
                    clientOid,
                    price: parseFloat(price),
                    size: size
                  });
                }
              } else if (status === 'cancelled' || status === 'canceled') {
                this.emit('order_cancelled', {
                  clientOid,
                  price: parseFloat(price),
                  side
                });
              }
              
              // Émettre l'événement générique de mise à jour
              this.emit('order_update', order);
            });
          }
        } catch (error) {
          console.error('❌ Erreur de traitement du message privé:', error.message);
        }
      });
      
      this.privateWs.on('error', (error) => {
        console.error(`❌ Erreur WebSocket privé: ${error.message}`);
        this.privateConnected = false;
        this.isAuthenticated = false;
        reject(error);
      });
      
      this.privateWs.on('close', () => {
        console.warn(`⚠️ WebSocket privé déconnecté`);
        this.privateConnected = false;
        this.isAuthenticated = false;
        
        // Nettoyer les intervalles
        if (this.privatePingInterval) {
          clearInterval(this.privatePingInterval);
          this.privatePingInterval = null;
        }
      });
    });
  }
  
  authenticate() {
    if (!this.privateConnected) {
      console.error('❌ WebSocket privé non connecté, impossible de s\'authentifier');
      return;
    }
    
    console.log('🔑 Authentification en cours...');
    
    const { apiKey, secretKey, passphrase } = this.config.apiKeys;
    const timestamp = Math.floor(Date.now() / 1000);
    
    // Message à signer
    const signMessage = timestamp + 'GET' + '/user/verify';
    
    // Générer la signature
    const signature = crypto
      .createHmac('sha256', secretKey)
      .update(signMessage)
      .digest('base64');
    
    const authMessage = {
      op: 'login',
      args: [
        {
          apiKey: apiKey,
          passphrase: passphrase,
          timestamp: timestamp.toString(),
          sign: signature
        }
      ]
    };
    
    this.privateWs.send(JSON.stringify(authMessage));
  }
  
  subscribeToPriceUpdates() {
    if (!this.publicConnected) {
      console.error('❌ WebSocket public non connecté, impossible de s\'abonner au prix');
      return;
    }
    
    const subscribeMessage = {
      op: 'subscribe',
      args: [
        {
          instType: 'SPOT',
          channel: 'ticker',
          instId: this.config.symbol
        }
      ]
    };
    
    console.log(`📤 Abonnement au canal ticker pour ${this.config.symbol}`);
    this.publicWs.send(JSON.stringify(subscribeMessage));
  }
  
  subscribeToOrderUpdates() {
    if (!this.privateConnected || !this.isAuthenticated) {
      console.error('❌ WebSocket privé non connecté ou non authentifié, impossible de s\'abonner aux ordres');
      return;
    }
    
    const subscribeMessage = {
      op: 'subscribe',
      args: [
        {
          instType: 'SPOT',
          channel: 'orders',
          instId: this.config.symbol
        }
      ]
    };
    
    console.log(`📤 Abonnement au canal des ordres pour ${this.config.symbol}`);
    this.privateWs.send(JSON.stringify(subscribeMessage));
  }
  
  setupPublicPingPong() {
    this.publicPingInterval = setInterval(() => {
      if (this.publicConnected) {
        this.publicWs.send('ping');
      }
    }, this.config.pingInterval);
  }
  
  setupPrivatePingPong() {
    this.privatePingInterval = setInterval(() => {
      if (this.privateConnected) {
        this.privateWs.send('ping');
      }
    }, this.config.pingInterval);
  }
  
  // Gestion de la file d'attente pour les ordres
  
  // Démarrer le traitement par lots
  startBatchProcessing() {
    // Clear any existing interval
    if (this.batchInterval) {
      clearInterval(this.batchInterval);
    }
    
    this.batchInterval = setInterval(() => {
      this.processBatchQueue();
    }, this.config.batchProcessing.batchInterval);
    
    console.log(`⚙️ Traitement par lots démarré (intervalle: ${this.config.batchProcessing.batchInterval}ms)`);
  }
  
  // Ajouter un message à la file d'attente
  queueMessage(message, type) {
    if (!type || !this.messageQueue[type]) {
      console.error(`❌ Type de message invalide: ${type}`);
      return;
    }
    
    this.messageQueue[type].push(message);
  }
  
  // Traiter la file d'attente
  processBatchQueue() {
    if (this.processingQueue || !this.privateConnected || !this.isAuthenticated) {
      return;
    }
    
    this.processingQueue = true;
    
    const allMessages = [];
    const priorities = this.config.batchProcessing.priorityOrder;
    
    // Collecter les messages selon les priorités
    for (const type of priorities) {
      while (this.messageQueue[type].length > 0 && 
             allMessages.length < this.config.batchProcessing.maxBatchSize) {
        allMessages.push(this.messageQueue[type].shift());
      }
    }
    
    if (allMessages.length > 0) {
      console.log(`📤 Envoi d'un lot de ${allMessages.length} messages`);
      
      for (const message of allMessages) {
        try {
          this.privateWs.send(JSON.stringify(message));
        } catch (error) {
          console.error('❌ Erreur lors de l\'envoi du message:', error);
        }
      }
    }
    
    this.processingQueue = false;
  }
  
  // Obtenir le prix actuel
  getCurrentPrice() {
    return this.currentPrice;
  }
  
  // Fermer proprement les connexions
  disconnect() {
    console.log('🛑 Déconnexion des WebSockets');
    
    // Arrêter le traitement par lots
    if (this.batchInterval) {
      clearInterval(this.batchInterval);
      this.batchInterval = null;
    }
    
    // Arrêter les pings
    if (this.publicPingInterval) {
      clearInterval(this.publicPingInterval);
      this.publicPingInterval = null;
    }
    
    if (this.privatePingInterval) {
      clearInterval(this.privatePingInterval);
      this.privatePingInterval = null;
    }
    
    // Fermer les connexions
    if (this.publicWs) {
      this.publicWs.close();
      this.publicWs = null;
    }
    
    if (this.privateWs) {
      this.privateWs.close();
      this.privateWs = null;
    }
    
    this.publicConnected = false;
    this.privateConnected = false;
    this.isAuthenticated = false;
    
    console.log('👋 WebSockets déconnectés proprement');
  }
}

module.exports = WebSocketClient; 