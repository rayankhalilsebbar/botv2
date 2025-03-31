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

    // Timeouts pour les pongs
    this.publicPongTimeout = null;
    this.privatePongTimeout = null;

    // Paramètres de reconnexion
    this.publicReconnectAttempts = 0;
    this.privateReconnectAttempts = 0;
    this.maxReconnectAttempts = 5;
    this.publicScheduledReconnect = null;
    this.privateScheduledReconnect = null;
    
    // Indicateurs pour les reconnexions en cours
    this.publicReconnectionInProgress = false;
    this.privateReconnectionInProgress = false;
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
      console.log(`📊 État de la connexion publique: ws=${this.publicWs ? 'existe' : 'null'}, connecté=${this.publicConnected}`);
      
      this.publicWs.on('open', () => {
        console.log('✅ WebSocket public connecté');
        this.publicConnected = true;
        this.publicReconnectAttempts = 0;  // Réinitialiser les tentatives
        this.publicReconnectionInProgress = false;
        
        // S'abonner au canal ticker
        this.subscribeToPriceUpdates();
        
        // Configurer le ping/pong
        this.setupPublicPingPong();
        
        // Programmer une reconnexion
        this.schedulePublicReconnect();
        
        resolve();
      });
      
      this.publicWs.on('message', (message) => {
        try {
          const messageStr = message.toString();
          
          // Traiter le ping/pong en texte brut
          if (messageStr === 'pong') {
            console.log('✅ Pong reçu sur WebSocket public');
            // Nettoyer le timeout de pong
            if (this.publicPongTimeout) {
              clearTimeout(this.publicPongTimeout);
              this.publicPongTimeout = null;
            }
            return;
          }
          
          const data = JSON.parse(messageStr);
          
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
      
      this.publicWs.on('close', (code, reason) => {
        console.warn(`⚠️ WebSocket public déconnecté: Code=${code}, Raison=${reason || 'Non spécifiée'}`);
        this.publicConnected = false;
        
        // Nettoyer les intervalles
        if (this.publicPingInterval) {
          clearInterval(this.publicPingInterval);
          this.publicPingInterval = null;
        }
        
        if (this.publicScheduledReconnect) {
          clearTimeout(this.publicScheduledReconnect);
          this.publicScheduledReconnect = null;
        }
        
        // Tenter de se reconnecter seulement si la déconnexion n'est pas due à une reconnexion programmée
        if (!this.publicReconnectionInProgress) {
          this.reconnectPublic();
        }
      });
    });
  }
  
  async connectPrivate() {
    return new Promise((resolve, reject) => {
      console.log(`🔌 Connexion au WebSocket privé: ${this.config.wsEndpoints.private}`);
      
      this.privateWs = new WebSocket(this.config.wsEndpoints.private);
      console.log(`📊 État de la connexion privée: ws=${this.privateWs ? 'existe' : 'null'}, connecté=${this.privateConnected}, authentifié=${this.isAuthenticated}`);
      
      this.privateWs.on('open', () => {
        console.log('✅ WebSocket privé connecté');
        this.privateConnected = true;
        this.privateReconnectAttempts = 0;  // Réinitialiser les tentatives
        this.privateReconnectionInProgress = false;
        
        // S'authentifier
        this.authenticate();
        
        // Configurer le ping/pong
        this.setupPrivatePingPong();
        
        // Programmer une reconnexion
        this.schedulePrivateReconnect();
        
        resolve();
      });
      
      this.privateWs.on('message', (message) => {
        try {
          const messageStr = message.toString();
          
          // Traiter le ping/pong en texte brut
          if (messageStr === 'pong') {
            console.log('✅ Pong reçu sur WebSocket privé');
            // Nettoyer le timeout de pong
            if (this.privatePongTimeout) {
              clearTimeout(this.privatePongTimeout);
              this.privatePongTimeout = null;
            }
            return;
          }
          
          const data = JSON.parse(messageStr);
          
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
              
              console.log(`📋 Mise à jour d'ordre reçue: ${clientOid}, Statut: ${status}`);
              
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
                    size: parseFloat(size)
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
      
      this.privateWs.on('close', (code, reason) => {
        console.warn(`⚠️ WebSocket privé déconnecté: Code=${code}, Raison=${reason || 'Non spécifiée'}`);
        this.privateConnected = false;
        this.isAuthenticated = false;
        
        // Nettoyer les intervalles
        if (this.privatePingInterval) {
          clearInterval(this.privatePingInterval);
          this.privatePingInterval = null;
        }
        
        if (this.privateScheduledReconnect) {
          clearTimeout(this.privateScheduledReconnect);
          this.privateScheduledReconnect = null;
        }
        
        // Tenter de se reconnecter seulement si la déconnexion n'est pas due à une reconnexion programmée
        if (!this.privateReconnectionInProgress) {
          this.reconnectPrivate();
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
  
  unsubscribeFromPriceUpdates() {
    if (!this.publicConnected) return;
    
    try {
      const unsubscribeMessage = {
        op: 'unsubscribe',
        args: [
          {
            instType: 'SPOT',
            channel: 'ticker',
            instId: this.config.symbol
          }
        ]
      };
      
      console.log(`📤 Désabonnement du canal ticker pour ${this.config.symbol}`);
      this.publicWs.send(JSON.stringify(unsubscribeMessage));
    } catch (error) {
      console.error(`❌ Erreur lors du désabonnement aux mises à jour de prix:`, error.message);
    }
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
  
  unsubscribeFromOrderUpdates() {
    if (!this.privateConnected || !this.isAuthenticated) return;
    
    try {
      const unsubscribeMessage = {
        op: 'unsubscribe',
        args: [
          {
            instType: 'SPOT',
            channel: 'orders',
            instId: this.config.symbol
          }
        ]
      };
      
      console.log(`📤 Désabonnement du canal des ordres pour ${this.config.symbol}`);
      this.privateWs.send(JSON.stringify(unsubscribeMessage));
    } catch (error) {
      console.error(`❌ Erreur lors du désabonnement aux mises à jour d'ordres:`, error.message);
    }
  }
  
  setupPublicPingPong() {
    // Nettoyer l'intervalle existant si présent
    if (this.publicPingInterval) {
      clearInterval(this.publicPingInterval);
    }

    // Configurer l'intervalle de ping
    this.publicPingInterval = setInterval(() => {
      if (this.publicWs && this.publicConnected) {
        console.log('📤 Ping envoyé sur WebSocket public');
        this.publicWs.send('ping');

        // Nettoyer le timeout précédent s'il existe
        if (this.publicPongTimeout) {
          clearTimeout(this.publicPongTimeout);
        }

        // Configurer le timeout pour le pong
        this.publicPongTimeout = setTimeout(() => {
          console.warn('⚠️ Timeout du pong sur WebSocket public');
          this.publicWs.close();
        }, 5000);
      }
    }, this.config.pingInterval);
  }
  
  setupPrivatePingPong() {
    // Nettoyer l'intervalle existant si présent
    if (this.privatePingInterval) {
      clearInterval(this.privatePingInterval);
    }

    // Configurer l'intervalle de ping
    this.privatePingInterval = setInterval(() => {
      if (this.privateWs && this.privateConnected) {
        console.log('📤 Ping envoyé sur WebSocket privé');
        this.privateWs.send('ping');

        // Nettoyer le timeout précédent s'il existe
        if (this.privatePongTimeout) {
          clearTimeout(this.privatePongTimeout);
        }

        // Configurer le timeout pour le pong
        this.privatePongTimeout = setTimeout(() => {
          console.warn('⚠️ Timeout du pong sur WebSocket privé');
          this.privateWs.close();
        }, 5000);
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
    
    // Utiliser les nouvelles méthodes de déconnexion
    this.disconnectPublic();
    this.disconnectPrivate();
    
    this.isAuthenticated = false;
    console.log('👋 WebSockets déconnectés proprement');
  }
  
  schedulePublicReconnect() {
    if (this.publicScheduledReconnect) {
      clearTimeout(this.publicScheduledReconnect);
    }
    
    this.publicScheduledReconnect = setTimeout(() => {
      console.log('⏰ Reconnexion programmée du WebSocket public déclenchée');
      this.reconnectPublic(true);
    }, this.config.reconnectInterval || 23 * 60 * 60 * 1000 + 50 * 60 * 1000); // 23h50m par défaut
  }
  
  schedulePrivateReconnect() {
    if (this.privateScheduledReconnect) {
      clearTimeout(this.privateScheduledReconnect);
    }
    
    this.privateScheduledReconnect = setTimeout(() => {
      console.log('⏰ Reconnexion programmée du WebSocket privé déclenchée');
      this.reconnectPrivate(true);
    }, this.config.reconnectInterval || 23 * 60 * 60 * 1000 + 50 * 60 * 1000); // 23h50m par défaut
  }
  
  reconnectPublic(scheduled = false) {
    // Si c'est une reconnexion programmée, déconnecter proprement d'abord
    if (scheduled) {
      console.log(`🔄 Début de la reconnexion programmée du WebSocket public`);
      this.publicReconnectionInProgress = true;
      this.publicReconnectAttempts = 0;
      
      // Déconnecter proprement avant de reconnecter
      this.disconnectPublic();
      
      // Ajouter un délai pour assurer que la déconnexion est complète
      setTimeout(() => {
        console.log(`🔄 Tentative de reconnexion programmée du WebSocket public`);
        this.connectPublic().catch(error => {
          console.error('❌ Échec de reconnexion programmée du WebSocket public:', error);
          this.publicReconnectionInProgress = false;
        });
      }, 3000); // Délai de 3 secondes
      
      return; // Sortir pour éviter le code de reconnexion standard
    }
    
    // Reconnexion standard (non programmée)
    if (this.publicReconnectAttempts < this.maxReconnectAttempts) {
      this.publicReconnectAttempts++;
      const delay = Math.min(1000 * Math.pow(2, this.publicReconnectAttempts), 30000);
      
      console.log(`🔄 Tentative de reconnexion du WebSocket public ${this.publicReconnectAttempts}/${this.maxReconnectAttempts} dans ${delay}ms`);
      
      setTimeout(() => {
        this.connectPublic().catch(error => {
          console.error('❌ Échec de reconnexion du WebSocket public:', error);
        });
      }, delay);
    } else {
      console.error('❌ Nombre maximum de tentatives de reconnexion du WebSocket public atteint');
      
      setTimeout(() => {
        console.log('🔄 Réinitialisation des tentatives de reconnexion du WebSocket public');
        this.publicReconnectAttempts = 0;
        this.connectPublic().catch(error => {
          console.error('❌ Échec de reconnexion du WebSocket public après réinitialisation:', error);
        });
      }, 60000);
    }
  }
  
  reconnectPrivate(scheduled = false) {
    // Si c'est une reconnexion programmée, déconnecter proprement d'abord
    if (scheduled) {
      console.log(`🔄 Début de la reconnexion programmée du WebSocket privé`);
      this.privateReconnectionInProgress = true;
      this.privateReconnectAttempts = 0;
      
      // Déconnecter proprement avant de reconnecter
      this.disconnectPrivate();
      
      // Ajouter un délai pour assurer que la déconnexion est complète
      setTimeout(() => {
        console.log(`🔄 Tentative de reconnexion programmée du WebSocket privé`);
        this.connectPrivate().catch(error => {
          console.error('❌ Échec de reconnexion programmée du WebSocket privé:', error);
          this.privateReconnectionInProgress = false;
        });
      }, 3000); // Délai de 3 secondes
      
      return; // Sortir pour éviter le code de reconnexion standard
    }
    
    // Reconnexion standard (non programmée)
    if (this.privateReconnectAttempts < this.maxReconnectAttempts) {
      this.privateReconnectAttempts++;
      const delay = Math.min(1000 * Math.pow(2, this.privateReconnectAttempts), 30000);
      
      console.log(`🔄 Tentative de reconnexion du WebSocket privé ${this.privateReconnectAttempts}/${this.maxReconnectAttempts} dans ${delay}ms`);
      
      setTimeout(() => {
        this.connectPrivate().catch(error => {
          console.error('❌ Échec de reconnexion du WebSocket privé:', error);
        });
      }, delay);
    } else {
      console.error('❌ Nombre maximum de tentatives de reconnexion du WebSocket privé atteint');
      
      setTimeout(() => {
        console.log('🔄 Réinitialisation des tentatives de reconnexion du WebSocket privé');
        this.privateReconnectAttempts = 0;
        this.connectPrivate().catch(error => {
          console.error('❌ Échec de reconnexion du WebSocket privé après réinitialisation:', error);
        });
      }, 60000);
    }
  }

  disconnectPublic() {
    console.log(`🔌 Déconnexion du WebSocket public initiée`);
    
    // Nettoyer les timeouts et intervalles
    if (this.publicPingInterval) {
      console.log('🧹 Nettoyage de l\'intervalle de ping public');
      clearInterval(this.publicPingInterval);
      this.publicPingInterval = null;
    }
    
    if (this.publicPongTimeout) {
      console.log('🧹 Nettoyage du timeout de pong public');
      clearTimeout(this.publicPongTimeout);
      this.publicPongTimeout = null;
    }
    
    if (this.publicScheduledReconnect) {
      console.log('🧹 Nettoyage de la reconnexion programmée publique');
      clearTimeout(this.publicScheduledReconnect);
      this.publicScheduledReconnect = null;
    }
    
    // Se désabonner avant de fermer
    if (this.publicWs && this.publicConnected) {
      try {
        this.unsubscribeFromPriceUpdates();
      } catch (error) {
        console.error('❌ Erreur lors du désabonnement:', error.message);
      }
    }
    
    if (this.publicWs) {
      console.log('👋 Fermeture de la connexion WebSocket publique');
      
      // Supprimer tous les listeners
      this.publicWs.removeAllListeners('message');
      this.publicWs.removeAllListeners('open');
      this.publicWs.removeAllListeners('close');
      this.publicWs.removeAllListeners('error');
      
      // Fermer la connexion avec un code normal
      try {
        this.publicWs.close(1000, 'Fermeture normale');
      } catch (error) {
        console.error('❌ Erreur lors de la fermeture du WebSocket public:', error.message);
      }
      
      this.publicWs = null;
    }
    
    // Réinitialiser les états
    this.publicConnected = false;
    
    console.log('✅ Déconnexion du WebSocket public terminée');
  }

  disconnectPrivate() {
    console.log(`🔌 Déconnexion du WebSocket privé initiée`);
    
    // Nettoyer les timeouts et intervalles
    if (this.privatePingInterval) {
      console.log('🧹 Nettoyage de l\'intervalle de ping privé');
      clearInterval(this.privatePingInterval);
      this.privatePingInterval = null;
    }
    
    if (this.privatePongTimeout) {
      console.log('🧹 Nettoyage du timeout de pong privé');
      clearTimeout(this.privatePongTimeout);
      this.privatePongTimeout = null;
    }
    
    if (this.privateScheduledReconnect) {
      console.log('🧹 Nettoyage de la reconnexion programmée privée');
      clearTimeout(this.privateScheduledReconnect);
      this.privateScheduledReconnect = null;
    }
    
    // Se désabonner avant de fermer
    if (this.privateWs && this.privateConnected && this.isAuthenticated) {
      try {
        this.unsubscribeFromOrderUpdates();
      } catch (error) {
        console.error('❌ Erreur lors du désabonnement:', error.message);
      }
    }
    
    if (this.privateWs) {
      console.log('👋 Fermeture de la connexion WebSocket privée');
      
      // Supprimer tous les listeners
      this.privateWs.removeAllListeners('message');
      this.privateWs.removeAllListeners('open');
      this.privateWs.removeAllListeners('close');
      this.privateWs.removeAllListeners('error');
      
      // Fermer la connexion avec un code normal
      try {
        this.privateWs.close(1000, 'Fermeture normale');
      } catch (error) {
        console.error('❌ Erreur lors de la fermeture du WebSocket privé:', error.message);
      }
      
      this.privateWs = null;
    }
    
    // Réinitialiser les états
    this.privateConnected = false;
    this.isAuthenticated = false;
    
    console.log('✅ Déconnexion du WebSocket privé terminée');
  }
}

module.exports = WebSocketClient; 
