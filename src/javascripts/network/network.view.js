

var $ = require('jquery');
var _ = require('lodash');
var Backbone = require('backbone');
var Cocktail = require('backbone.cocktail');
var ScalesMixin = require('../mixins/scales.mixin');
var Radio = require('backbone.radio');
var d3 = require('d3-browserify');
var rbush = require('rbush');


var Network = module.exports = Backbone.View.extend({


  el: '#network',

  options: {
    padding: 50,
    fontExtent: [4, 70],
    zoomExtent: [0.1, 50],
    edgeCount: 1000,
    panDuration: 800,
    focusScale: 10
  },


  /**
   * Spin up the network.
   */
  initialize: function(options) {

    this.data = options;

    this._initRadio();
    this._initMarkup();
    this._initZoom();
    this._initResize();
    this._initNodes();
    this._initEdges();

    this.triggerZoom();

  },


  /**
   * Connect to event channels.
   */
  _initRadio: function() {
    this.radio = Radio.channel('network');
  },


  /**
   * Inject the top-level containers.
   */
  _initMarkup: function() {

    // Top-level SVG element.
    this.svg = d3.select(this.el);

    // Zoomable container.
    this.outer = this.svg.append('g');

    // Pointer events overlay.
    this.zoomOverlay = this.outer.append('rect')
      .classed({ overlay: true });

    // Edges <g>.
    this.edgeGroup = this.outer.append('g')
      .classed({ edges: true });

    // Nodes <g>.
    this.nodeGroup = this.outer.append('g')
      .classed({ nodes: true });

  },


  /**
   * Attach a zoom handler to the outer <g>.
   */
  _initZoom: function() {

    // Construct the zoom handler.
    this.zoom = d3.behavior.zoom()
      .on('zoom', _.bind(this.renderZoom, this))
      .scaleExtent(this.options.zoomExtent);

    // Add zoom to <g>.
    this.outer.call(this.zoom);

    // Zoom -> font size scale.
    this.fontScale = d3.scale.linear()
      .domain(this.options.zoomExtent)
      .range(this.options.fontExtent);

    // Debounce a zoom-end callback.
    this.debouncedZoomEnd = _.debounce(
      this.onZoomEnd, 200
    );

  },


  /**
   * Bind a debounced resize listener.
   */
  _initResize: function() {

    // Debounce the resizer.
    var resize = _.debounce(_.bind(function() {
      this.fitWindow();
      this.triggerZoom();
    }, this), 500);

    // Bind to window resize.
    $(window).resize(resize);
    this.fitWindow();

  },


  /**
   * Render the nodes.
   */
  _initNodes: function() {

    this.labelToNode = {};
    this.selected = null;

    // Iterate over nodes.
    _.map(this.data.nodes, _.bind(function(n) {

      // Inject the label.
      var node = this.nodeGroup
        .append('text')
        .datum(n)
        .attr('text-anchor', 'middle')
        .classed({ node: true })
        .text(n.label);

      // Map label -> element.
      this.labelToNode[n.label] = node;

    }, this));

    // Select the collection.
    this.nodes = this.nodeGroup.selectAll('text');

    // Highlight on focus.
    this.nodes.on('mouseenter', _.bind(function(d) {
      this.publishHighlight(d.label);
    }, this));

    // Select on click.
    this.nodes.on('click', _.bind(function(d) {
      d3.event.stopPropagation();
      this.publishSelect(d.label);
    }, this));

    // Unhighlight on blur.
    this.nodes.on('mouseleave', _.bind(function() {
      this.publishUnhighlight();
    }, this));

    this.outer.on('click', _.bind(function() {
      if (d3.event.defaultPrevented) return;
      this.publishUnselect();
    }, this));

  },


  /**
   * Initialize the edge index.
   */
  _initEdges: function() {

    // Load the index.
    this.edgeIndex = new rbush();
    this.edgeIndex.load(this.data.edges);

    // Init selection.
    this.selectEdges();

  },


  /**
   * Programmatically trigger a `zoom` event.
   */
  triggerZoom: function() {
    this.zoom.event(this.outer);
  },


  /**
   * Apply the current zoom level to the nodes/edges.
   */
  renderZoom: function() {

    this.renderNodes();

    // Hide the edges while panning.
    this.edgeGroup.style('display', 'none');

    // Get current focus.
    var x = this.xScale.invert(this.w/2);
    var y = this.yScale.invert(this.h/2);
    var z = this.zoom.scale();

    // Get current extent.
    var x1 = this.xScale.invert(0);
    var y1 = this.yScale.invert(0);
    var x2 = this.xScale.invert(this.w);
    var y2 = this.yScale.invert(this.h);

    // On zoom, update the font sizes.
    if (!this.center || z != this.center.z) {
      this.nodeGroup.style('font-size', this.fontScale(z)+'px');
    }

    // Set the new extent and center.
    this.extent = { x1:x1, y1:y1, x2:x2, y2:y2 };
    this.center = { x:x, y:y, z:z };

    // Publish the extent.
    this.radio.trigger('extent', this.extent);

    // Notify zoom end.
    this.debouncedZoomEnd();

  },


  /**
   * Render the node positions.
   */
  renderNodes: function() {

    this.nodes.attr('transform', _.bind(function(d) {
      return 'translate('+
        this.xScale(d.graphics.x)+','+
        this.yScale(d.graphics.y)+
      ')';
    }, this));

  },


  /**
   * Update the edge selection and re-render.
   */
  refreshEdges: function() {
    this.selectEdges();
    this.positionEdges();
  },


  /**
   * Cache the edge selection.
   */
  selectEdges: function() {
    this.edges = this.edgeGroup.selectAll('line');
  },


  /**
   * Render the edge positions.
   *
   * @param {Selection} edges
   */
  positionEdges: function(edges) {

    var self = this;
    edges = edges || this.edges;

    edges.each(function(d) {
      d3.select(this).attr({
        x1: self.xScale(d.x1),
        y1: self.yScale(d.y1),
        x2: self.xScale(d.x2),
        y2: self.yScale(d.y2)
      })
    });

  },


  /**
   * After a zoom, query for new edges and update the route.
   */
  onZoomEnd: function() {
    this.filterEdgesByExtent();
    this.edgeGroup.style('display', null);
    this.updateRouteXYZ();
  },


  /**
   * Clear the current background edges and render a new set of edges that
   * fall within the current viewport extent.
   */
  filterEdgesByExtent: function() {

    // Get current BBOX.
    var x1 = this.xScale.invert(0);
    var y1 = this.yScale.invert(this.h);
    var x2 = this.xScale.invert(this.w);
    var y2 = this.yScale.invert(0);

    // Query for visible edges.
    var edges = this.edgeIndex.search([
      x1, y1, x2, y2
    ]);

    // Sort by edge weight.
    var edges = _.sortBy(edges, function(e) {
      return 1-e[4].weight
    });

    // Take the X heaviest edges.
    var edges = _.first(edges, this.options.edgeCount);

    // Clear current edges.
    this.edgeGroup
      .selectAll('line.background')
      .remove();

    // Walk the 1000 heaviest edges.
    _.each(edges, _.bind(function(e) {

      // Render the new edges.
      this.edgeGroup.append('line')
        .classed({ background: true })
        .datum({
          x1: e[0],
          y1: e[1],
          x2: e[2],
          y2: e[3]
        });

    }, this));

    this.refreshEdges();

  },


  /**
   * Point the route to current XYZ location.
   */
  updateRouteXYZ: function() {

    if (this.selected) return;

    // Round off the coordinates.
    var x = this.center.x.toFixed(2);
    var y = this.center.y.toFixed(2);
    var z = this.center.z.toFixed(2);

    // Update the route.
    Backbone.history.navigate(x+'/'+y+'/'+z, {
      replace: true
    });

  },


  /**
   * Point the route to a specific term.
   *
   * @param {String} label
   */
  updateRouteTerm: function(label) {
    Backbone.history.navigate(label, {
      replace: true
    });
  },


  /**
   * Fill the window with the network.
   */
  fitWindow: function() {

    // Measure the window.
    this.h = $(window).height();
    this.w = $(window).width();

    // Fit the scales to the node extent.
    this.fitScales(this.data.extent, this.h, this.w);

    // Size the SVG container.
    this.svg
      .attr('height', this.h)
      .attr('width', this.w);

    // Size the overlay.
    this.zoomOverlay
      .attr('height', this.h)
      .attr('width', this.w);

    // Update the zoom handler.
    this.zoom
      .size([this.w, this.h])
      .x(this.xScale)
      .y(this.yScale);

    // Reset the current focus.
    if (this.center) {
      this.focusOnXYZ(this.center);
    }

  },


  /**
   * Apply a :x/:y/:z focus position.
   *
   * @param {Object} center
   * @param {Boolean} animate
   */
  focusOnXYZ: function(center, animate) {

    z = center.z || this.center.z;

    // Reset the focus, apply zoom.
    this.zoom.translate([0, 0]).scale(z);

    // X/Y coordinate of the centroid.
    var x = this.xScale(center.x);
    var y = this.yScale(center.y);

    // Distance from viewport center.
    var dx = this.w/2 - x;
    var dy = this.h/2 - y;

    // Apply the new translation.
    this.zoom.translate([dx, dy]);

    // Animate if duration.
    if (animate === true) {
      this.outer.transition()
        .duration(this.options.panDuration)
        .call(this.zoom.event);
    }

    // Else, apply now.
    else this.triggerZoom();

  },


  /**
   * Focus on an individual word.
   *
   * @param {String} word
   * @param {Boolean} animate
   */
  focusOnWord: function(word, animate) {

    // Get the coordinates.
    var d = this.data.nodes[word];

    var center = {
      x: d.graphics.x,
      y: d.graphics.y,
      z: this.options.focusScale
    };

    // Apply the center.
    this.focusOnXYZ(center, animate);

  },


  /**
   * Publish a node highlight.
   *
   * @param {String} label
   */
  publishHighlight: function(label) {
    this.renderHighlight(label);
    this.radio.trigger('highlight', label);
  },


  /**
   * Publish a node selection.
   *
   * @param {String} label
   */
  publishSelect: function(label) {
    this.renderSelect(label);
    this.radio.trigger('select', label);
    this.updateRouteTerm(label);
  },


  /**
   * Publish a node unhighlight.
   */
  publishUnhighlight: function() {
    this.renderUnhighlight();
    this.radio.trigger('unhighlight');
  },


  /**
   * Publish a node unselect.
   */
  publishUnselect: function() {
    this.renderUnselect();
    this.radio.trigger('unselect');
    this.updateRouteXYZ();
  },


  /**
   * Highlight a node.
   *
   * @param {String} label
   */
  renderHighlight: function(label) {

    // Get the source coordinates.
    var sourceDatum = this.data.nodes[label];
    var sx = sourceDatum.graphics.x;
    var sy = sourceDatum.graphics.y;

    // Highlight the source <text>.
    this.labelToNode[label]
      .classed({ highlight: true, source: true });

    // Iterate over the targets.
    _.each(sourceDatum.targets, _.bind(function(label) {

      // Highlight the target <text>'s.
      this.labelToNode[label]
        .classed({ highlight: true })

      // Get the target coordinates.
      var targetDatum = this.data.nodes[label]
      var tx = targetDatum.graphics.x;
      var ty = targetDatum.graphics.y;

      // Inject the edge.
      this.edgeGroup.append('line')
        .classed({ highlight: true })
        .datum({
          x1: sx,
          y1: sy,
          x2: tx,
          y2: ty
        });

    }, this));

    // Render new edges.
    this.positionEdges(
      this.edgeGroup.selectAll('line.highlight')
    );

  },


  /**
   * Select a node.
   */
  renderSelect: function(label) {

    this.selected = label;
    this.renderUnselect();

    this.labelToNode[label]
      .classed({ select: true });

  },


  /**
   * Unhighlight all nodes.
   */
  renderUnhighlight: function() {

    var self = this;

    // Remove highlight classes.
    this.nodes
      .filter('.highlight')
      .classed({ highlight: false, source: false });

    // Remove the highlight lines.
    this.edgeGroup
      .selectAll('line.highlight')
      .remove();

  },


  /**
   * Unselect the currently-selected node.
   */
  renderUnselect: function() {

    this.nodes
      .filter('.select')
      .classed({ select: false });

    this.selected = null;

  }


});


// Mixins:
Cocktail.mixin(Network, ScalesMixin);
