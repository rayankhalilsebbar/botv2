// grid-strategy.js
class GridStrategy {
  constructor(config, orderService, wsClient) {
    this.config = config;
    this.orderService = orderService;
    this.wsClient = wsClient;
    
    this.running = false;
    this.updateInterval = null;
    this.lastProcessedPrice = null;
    this.lastGridUpdateTime = null;
    this.lastBasePrice = null;
    
    // Écouteurs d'événements liés à la stratégie
    this.setupEventListeners();
  }
  
  setupEventListeners() {
    // Mise à jour du prix
    this.wsClient.on('price_update', (price) => {
      // Simplement stocker le nouveau prix, l'intervalle s'occupera de la mise à jour
      this.lastProcessedPrice = price;
    });
    
    // Exécution d'un ordre d'achat - déjà géré par OrderService qui place l'ordre de vente
    this.wsClient.on('strategy_buy_filled', (data) => {
      console.log(`📈 Stratégie: Achat exécuté à ${data.price}$, ordre de vente placé à ${data.sellPrice}$`);
    });
    
    // Exécution d'un ordre de vente - modification pour ne plus afficher le prix d'achat puisqu'il n'est plus placé automatiquement
    this.wsClient.on('strategy_sell_filled', (data) => {
      console.log(`📉 Stratégie: Vente exécutée à ${data.price}$`);
      
      // NOUVELLE MODIFICATION: Déclencher updateGrid() après chaque vente pour maintenir la grille complète
      setTimeout(() => {
        console.log(`🔄 Mise à jour de la grille déclenchée après vente à ${data.price}$`);
        this.forceUpdateGrid();
      }, 100); // Petit délai pour laisser le temps à l'ordre d'être retiré des listes actives
    });
  }
  
  // Nouvelle méthode pour forcer la mise à jour de la grille sans vérifier si le prix a changé
  forceUpdateGrid() {
    if (!this.running) return;
    
    const currentPrice = this.wsClient.getCurrentPrice();
    if (!currentPrice) {
      console.log('⚠️ Impossible de mettre à jour la grille: prix actuel non disponible');
      return;
    }
    
    // Calculer le prix de base actuel
    const currentBasePrice = Math.floor(currentPrice / this.config.priceStep) * this.config.priceStep;
    
    console.log(`🔄 Mise à jour forcée de la grille - Prix actuel: ${currentPrice}$ (base: ${currentBasePrice}$)`);
    
    // Ajuster la grille
    this.adjustGridUpwards(currentBasePrice);
    
    // Mémoriser le nouveau prix de base si nécessaire
    if (currentBasePrice > this.lastBasePrice) {
      this.lastBasePrice = currentBasePrice;
    }
    
    // Mettre à jour l'horodatage de la dernière mise à jour
    this.lastGridUpdateTime = Date.now();
    this.lastProcessedPrice = currentPrice;
  }
  
  // Démarrer la stratégie
  start() {
    if (this.running) return;
    this.running = true;
    
    console.log('🚀 Démarrage de la stratégie de grid trading');
    
    // Vérifier si nous avons un prix valide
    const currentPrice = this.wsClient.getCurrentPrice();
    if (!currentPrice) {
      console.error('❌ Impossible de démarrer la stratégie: prix actuel non disponible');
      this.running = false;
      return;
    }
    
    // Générer et placer la grille initiale
    this.initialGridPlacement(currentPrice);
    
    // Configurer l'intervalle de mise à jour
    const updateInterval = this.config.strategy.updateInterval || 5000;
    this.updateInterval = setInterval(() => this.updateGrid(), updateInterval);
    
    console.log(`⏱️ Grille configurée pour mise à jour toutes les ${updateInterval / 1000} secondes`);
  }
  
  // Arrêter la stratégie
  stop() {
    if (!this.running) return;
    
    if (this.updateInterval) {
      clearInterval(this.updateInterval);
      this.updateInterval = null;
    }
    
    this.running = false;
    console.log('⏹️ Stratégie de grid trading arrêtée');
  }
  
  // Placement initial de la grille
  initialGridPlacement(currentPrice) {
    console.log(`📐 Génération de la grille initiale (prix actuel: ${currentPrice}$)`);
    
    // Calculer le prix de base (arrondi au palier inférieur)
    const basePrice = Math.floor(currentPrice / this.config.priceStep) * this.config.priceStep;
    
    // Mémoriser ce prix de base
    this.lastBasePrice = basePrice;
    
    // Générer la grille
    const grid = this.generateGrid(currentPrice);
    
    // Préparer les données pour les ordres d'achat
    const buyOrdersData = grid.map(price => ({
      price,
      size: this.orderService.calculateOrderSize(price)
    }));
    
    // Placer les ordres d'achat initiaux
    this.orderService.placeBulkOrders(buyOrdersData, 'buy');
    
    console.log(`✅ Grille initiale générée avec ${grid.length} niveaux de prix`);
  }
  
  // Générer la grille de prix
  generateGrid(currentPrice) {
    // Calculer le prix de base (arrondi au palier inférieur)
    const basePrice = Math.floor(currentPrice / this.config.priceStep) * this.config.priceStep;
    
    // Générer les paliers de la grille
    const grid = [];
    
    // Générer maxOrders paliers sous le prix actuel, en commençant par le premier palier sous le prix
    for (let i = 0; i < this.config.maxOrders; i++) {
      const price = parseFloat((basePrice - (i * this.config.priceStep)).toFixed(this.config.pricePrecision));
      
      // Ne pas descendre en dessous de 0 (par précaution)
      if (price <= 0) break;
      
      grid.push(price);
    }
    
    return grid;
  }
  
  // Mise à jour périodique de la grille
  updateGrid() {
    if (!this.running) return;
    
    const currentPrice = this.wsClient.getCurrentPrice();
    if (!currentPrice) {
      console.log('⚠️ Impossible de mettre à jour la grille: prix actuel non disponible');
      return;
    }
    
    // Éviter les mises à jour trop fréquentes pour le même prix
    if (this.lastGridUpdateTime && 
        Date.now() - this.lastGridUpdateTime < 1000 && 
        this.lastProcessedPrice === currentPrice) {
      return;
    }
    
    // Calculer le prix de base actuel
    const currentBasePrice = Math.floor(currentPrice / this.config.priceStep) * this.config.priceStep;
    
    // Si le prix a baissé ou est resté stable, on ne fait rien
    if (this.lastBasePrice && currentBasePrice <= this.lastBasePrice) {
      // Mise à jour silencieuse (log uniquement si déboggage activé)
      // console.log(`💤 Prix actuel: ${currentPrice}$ (base: ${currentBasePrice}$) <= dernière base: ${this.lastBasePrice}$ - Pas d'ajustement`);
      return;
    }
    
    // Le prix a monté, on ajuste la grille vers le haut
    console.log(`📈 Le prix est monté - Prix actuel: ${currentPrice}$ (base: ${currentBasePrice}$ > dernière base: ${this.lastBasePrice}$)`);
    
    // Ajuster la grille vers le haut
    this.adjustGridUpwards(currentBasePrice);
    
    // Mémoriser le nouveau prix de base
    this.lastBasePrice = currentBasePrice;
    
    // Mettre à jour l'horodatage de la dernière mise à jour
    this.lastGridUpdateTime = Date.now();
    this.lastProcessedPrice = currentPrice;
  }
  
  // Nouvelle méthode pour l'ajustement vers le haut uniquement
  adjustGridUpwards(basePrice) {
    console.log(`📊 Ajustement de la grille vers le haut (nouvelle base: ${basePrice}$)`);
    
    // 1. Obtenir tous les ordres d'achat actifs
    const activeBuyOrders = this.orderService.getActiveBuyOrders();
    
    // 1b. Obtenir tous les ordres de vente actifs
    const activeSellOrders = this.orderService.getActiveSellOrders();
    
    // 2. Générer la nouvelle grille idéale
    const newGrid = this.generateGrid(basePrice);
    
    // 3. Identifier les ordres existants qui ne sont plus dans la grille idéale
    const ordersToCancel = [];
    const existingPrices = new Set();
    
    for (const order of activeBuyOrders) {
      existingPrices.add(order.price);
      
      // Si le prix n'est pas dans la nouvelle grille, on l'annule
      if (!newGrid.includes(order.price)) {
        ordersToCancel.push(order.clientOid);
      }
    }
    
    // 4. Identifier les nouveaux prix à ajouter
    const newPricesToAdd = newGrid.filter(price => {
      // Vérifie qu'il n'y a pas déjà un ordre d'achat à ce prix
      if (existingPrices.has(price)) {
        return false;
      }
      
      // Vérifie qu'il n'y a pas d'ordre de vente au niveau supérieur
      const sellPriceLevel = parseFloat((price + this.config.priceStep).toFixed(this.config.pricePrecision));
      if (this.orderService.hasSellOrderAtPrice(sellPriceLevel)) {
        return false;
      }
      
      return true;
    });
    
    // 5. Annuler les ordres qui ne sont plus dans la grille
    if (ordersToCancel.length > 0) {
      console.log(`❌ Annulation de ${ordersToCancel.length} ordres trop éloignés de la nouvelle grille`);
      this.orderService.cancelBulkOrders(ordersToCancel);
    }
    
    // 6. Calculer combien de nouveaux ordres on peut ajouter sans dépasser la limite
    // Nombre total d'ordres actifs après annulation
    const totalActiveOrders = activeBuyOrders.length + activeSellOrders.length - ordersToCancel.length;
    
    // Nombre d'emplacements disponibles
    const availableSlots = this.config.maxOrders - totalActiveOrders;
    
    // Trier les nouveaux prix à ajouter par proximité avec le prix actuel
    const currentPrice = this.wsClient.getCurrentPrice();
    newPricesToAdd.sort((a, b) => Math.abs(currentPrice - a) - Math.abs(currentPrice - b));
    
    // Limiter le nombre de nouveaux prix à ajouter
    const pricesToAdd = availableSlots > 0 ? newPricesToAdd.slice(0, availableSlots) : [];
    
    // NOUVELLE LOGIQUE: Détecter les trous dans la grille après les opérations standard
    if (pricesToAdd.length < newPricesToAdd.length && activeBuyOrders.length > 0) {
      // Il reste des prix qu'on voudrait ajouter mais pas assez d'emplacements
      // Chercher s'il y a des trous proches qui devraient être priorisés
      
      // Calculer la distance de chaque prix restant par rapport au prix actuel
      const remainingPrices = newPricesToAdd.slice(pricesToAdd.length).map(price => ({
        price,
        distanceFromCurrent: Math.abs(currentPrice - price)
      }));
      
      // Trier les prix restants du plus proche au plus éloigné
      remainingPrices.sort((a, b) => a.distanceFromCurrent - b.distanceFromCurrent);
      
      // Calculer la distance de chaque ordre actif par rapport au prix actuel
      // Exclure les ordres déjà prévus pour annulation
      const ordersToKeep = activeBuyOrders.filter(
        order => !ordersToCancel.includes(order.clientOid)
      );
      
      const existingOrdersWithDistance = ordersToKeep.map(order => ({
        order,
        distanceFromCurrent: Math.abs(currentPrice - order.price)
      }));
      
      // Trier du plus éloigné au plus proche
      existingOrdersWithDistance.sort((a, b) => b.distanceFromCurrent - a.distanceFromCurrent);
      
      // Ordres supplémentaires à annuler pour libérer de l'espace pour les trous proches
      const additionalOrdersToCancel = [];
      const additionalPricesToAdd = [];
      
      // Chercher les trous proches qui méritent de remplacer des ordres éloignés
      for (const holeInfo of remainingPrices) {
        // Chercher l'ordre le plus éloigné qui n'est pas encore marqué pour annulation
        if (existingOrdersWithDistance.length === 0) break;
        
        const farOrderInfo = existingOrdersWithDistance[0];
        
        // Vérifier si cet ordre est significativement plus éloigné que le trou
        if (farOrderInfo.distanceFromCurrent > holeInfo.distanceFromCurrent * 1.5) {
          // Cet ordre est au moins 50% plus éloigné que le trou, l'annuler
          additionalOrdersToCancel.push(farOrderInfo.order.clientOid);
          additionalPricesToAdd.push(holeInfo.price);
          
          console.log(`🔄 Optimisation: Annulation de l'ordre éloigné à ${farOrderInfo.order.price}$ (distance: ${farOrderInfo.distanceFromCurrent.toFixed(2)}) pour combler le trou à ${holeInfo.price}$ (distance: ${holeInfo.distanceFromCurrent.toFixed(2)})`);
          
          // Retirer cet ordre de la liste pour ne pas le réutiliser
          existingOrdersWithDistance.shift();
        } else {
          // Si l'ordre le plus éloigné n'est pas significativement plus loin que le trou,
          // passer au trou suivant qui est probablement encore plus loin
          break;
        }
      }
      
      // Annuler ces ordres supplémentaires si nécessaire
      if (additionalOrdersToCancel.length > 0) {
        console.log(`🔄 Réorganisation de la grille: Annulation de ${additionalOrdersToCancel.length} ordres éloignés pour combler des trous proches`);
        this.orderService.cancelBulkOrders(additionalOrdersToCancel);
        
        // Ajouter ces niveaux à la liste des prix à ajouter
        pricesToAdd.push(...additionalPricesToAdd);
        
        // Tri final par proximité
        pricesToAdd.sort((a, b) => Math.abs(currentPrice - a) - Math.abs(currentPrice - b));
      }
    }
    
    // 7. Ajouter les nouveaux ordres
    if (pricesToAdd.length > 0) {
      console.log(`📈 Ajout de ${pricesToAdd.length} nouveaux niveaux de prix à la grille`);
      
      const newOrdersData = pricesToAdd.map(price => ({
        price,
        size: this.orderService.calculateOrderSize(price)
      }));
      
      this.orderService.placeBulkOrders(newOrdersData, 'buy');
    }
    
    // 8. Calculer le nombre total d'ordres actifs après modifications
    const finalActiveBuyOrders = activeBuyOrders.length - ordersToCancel.length + pricesToAdd.length;
    
    console.log(`✅ Grille ajustée vers le haut: ${finalActiveBuyOrders} ordres actifs`);
  }
  
  // Afficher l'état actuel de la grille
  logGridStatus() {
    const activeBuyOrders = this.orderService.getActiveBuyOrders();
    const activeSellOrders = this.orderService.getActiveSellOrders();
    const totalOrders = activeBuyOrders.length + activeSellOrders.length;
    
    console.log(`
=== ÉTAT DE LA GRILLE ===
Prix actuel: ${this.wsClient.getCurrentPrice()}$
Prix base actuel: ${this.lastBasePrice}$
Ordres d'achat actifs: ${activeBuyOrders.length}
Ordres de vente actifs: ${activeSellOrders.length}
Total d'ordres actifs: ${totalOrders}
=======================
    `);
  }
}

module.exports = GridStrategy; 
