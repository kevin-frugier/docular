var Q = require('q');
var Class = require('./class');
var fs = require('fs');
var util = require('util');

var internalIdIncrementor = 1;

/*
 * This is a stub to get the promise chain rolling.
 */
var DocModel = function (docData) {this.docData = docData;};
DocModel.prototype.toJSON = function () {
    return this.docData;
};

function getExtension(filename) {
    var i = filename.lastIndexOf('.');
    return (i < 0) ? '' : filename.substr(i + 1);
}

var Group = Class.extend({
    
    _sections: null,
    fileData: null,
    docs: null,
    registry: null,
    
    events: [
        'FileRead',
        'FileParse',
        'FileParseBackfill',
        'CreateDocs',
        'GetPath'
    ],
    
    __constructor: function (groupData, config) {
        if(config) {
            this.setRegistry(config.registry);
        }
        this.internalGroupId = internalIdIncrementor++;
        this.setOptions(groupData);
        this.setupGroups();
        
        this.on('GetPath', function (paths) {
            paths.push(this.option('groupId'));
        }.bind(this));
    },
    
    setRegistry: function (registry) {
        this.registry = registry;
    },
    
    setOptions: function (groupData) {
        
        /*
         * Backwards compatibility
         */
        if(groupData.sections) {
            groupData.groups = groupData.sections;
        }
        if(groupData.id) {
            groupData.groupId = groupData.id;
        }
        if(groupData.title) {
            groupData.groupTitle = groupData.title;
        }
        if(!groupData.files) {
            groupData.files = [];
        }
        if(groupData.scripts) {
            groupData.files = groupData.files.concat(groupData.scripts);
        }
        if(groupData.docs) {
            groupData.files = groupData.files.concat(groupData.docs);
        }
        
        this.__base(groupData);
    },
    
    getPath: function () {
        var paths = [];
        this.emit('GetPath', paths);
        return paths.reverse().join('/');
    },
    
    setupGroups: function () {
        var groups = this.option('groups');
        var self = this;
        this._groups = [];
        if(!groups) { return; }
        for(var i = 0, l = groups.length; i < l; i++) {
            var group = new Group(groups[i], {
                registry: this.registry
            });
            this.events.forEach(function (evt) {
                group.on(evt, function () {
                    self.emit.apply(self, [evt].concat(Array.prototype.slice.apply(arguments)));
                });
            });
            this._groups.push(group);
        }
    },
    
    asyncEmit: function () {
        var promises = [];
        var args = Array.prototype.slice.apply(arguments);
        args.push(promises);
        this.emit.apply(this, args);
        var result = Q();
        for(var i = 0, l = promises.length; i < l; i++) {
            result = result.then(promises[i]);
        }
        return result;
    },
    
    runRecursively: function (method) {
        var promises = [];
        for(var i = 0, l = this._groups.length; i < l; i++) {
            promises.push(Q.fcall(this._groups[i][method].bind(this._groups[i])));
        }
        return Q.all(promises);
    },
    
    
    loadFiles: function() {
        console.info("Loading individual files for gid:", this.option('groupId'));
        var deferred = Q.defer();
        var promise = deferred.promise;
        var self = this;
        
        this.fileData = {};
        
        function readFile (file) {
            return function () {
                var deferred = Q.defer();
                fs.readFile(file, {encoding: 'utf8'}, function (err, data) {
                    if(err) { deferred.reject(err); return;}
                    self.fileData[file] = {
                        fileName: file,
                        content: data,
                        docs: [],
                        extension: getExtension(file)
                    };
                    self.asyncEmit('FileRead', self.fileData[file]).then(deferred.resolve, deferred.reject);
                });
                
                return deferred.promise;
            };
        }
        
        var files = this.option('files');
        var sequence = Q();
        for(var i = 0, l = files.length; i < l; i++) {
            sequence = sequence.then(readFile(files[i]));
        }
        
        sequence.then(function () {
            return this.runRecursively('loadFiles').then(deferred.resolve);
        }.bind(this)).catch(deferred.reject);
        
        return promise;
    },
    
    
    parseFiles: function () {
        console.info("Parsing files for gid: ", this.option('groupId'));
        
        var promises = [];
        var self = this;
        var files = this.option('files') || [];
        files.forEach(function (fileName) {
            promises.push(self.asyncEmit('FileParse', self.fileData[fileName], self.fileData));
        });
        
        return Q.all(promises).then(function () {
            return this.runRecursively('parseFiles');
        }.bind(this));
    },
    
    backfillParseData: function () {
        console.info("Backfilling file data for gid: ", this.option('groupId'));
        
        var promises = [];
        var self = this;
        var files = this.option('files') || [];
        files.forEach(function (fileName) {
            promises.push(self.asyncEmit('FileParseBackfill', self.fileData[fileName], self.fileData));
        });
        
        return Q.all(promises).then(function () {
            return this.runRecursively('backfillParseData');
        }.bind(this));
    },
    
    createDocs: function () {
        console.info("Creating docs from for gid: ", this.option('groupId'));
        var paths = this.getPath();
        var promises = [];
        var self = this;
        var files = this.option('files') || [];
        this.docs = [];
        
        files.forEach(function (fileName) {
            var docs = self.fileData[fileName].docs;
            docs.forEach(function (doc) {
                var docPromise = Q.fcall(function(){return new DocModel(doc);});
                var docPromises = [];
                self.emit('CreateDocs', doc, docPromises);
                for(var i = 0, l = docPromises.length; i < l; i++) {
                    docPromise = docPromise.then(docPromises[i]);
                }
                docPromise.then(function (docModel) {
                    docModel.setPath(paths);
                    self.docs.push(docModel);
                    docModel.groupId = self.internalGroupId;
                    self.files[fileName].docs.push(docModel);
                });
                promises.push(docPromise);
            });
        });
        
        return Q.all(promises).then(function () {
            return this.runRecursively('createDocs');
        }.bind(this));
    },
    
    buildRegistry: function () {
        this.docs.forEach(function (doc) {
            this.registry.addItem(doc.id, doc);
        }.bind(this));
        return this.runRecursively('buildRegistry');
    }
});

module.exports = Group;