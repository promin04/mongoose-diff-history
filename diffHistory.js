var History = require("./diffHistoryModel");
var async = require("async");
var jsondiffpatch = require("jsondiffpatch").create();
var moment = require("moment");
moment.locale('th');


var saveHistoryObject = function (history, callback){
    history.save(function (err) {

        if (err) {
            err.message = "Mongo Error :" + err.message;
        }
        callback();
    });
};

var saveDiffObject = function(currentObject, original, updated, user, reason, callback){

    var diff = jsondiffpatch.diff(JSON.parse(JSON.stringify(original)),
        JSON.parse(JSON.stringify(updated)));

    if (diff) {

        History.findOne({collectionName: currentObject.constructor.modelName, collectionId: currentObject._id}).sort("-version").exec(function (err, lastHistory) {
            if (err) {
                err.message = "Mongo Error :" + err.message;
                return callback();
            }

            var history = new History({
                collectionName: currentObject.constructor.modelName,
                collectionId: currentObject._id,
                diff: diff,
                user: user,
                reason: reason,
                version: lastHistory ? lastHistory.version + 1 : 0
            });
            history.markModified("diff");
            history.markModified("user");
            delete history.diff['$setOnInsert'];

            saveHistoryObject(history, callback);
        });
    }
    else{
        callback();
    }
};

var saveDiffHistory = function(queryObject, currentObject, callback) {

    currentObject.constructor.findOne({_id: currentObject._id}).lean().exec(
      function (err, selfObject) {

          if(selfObject){
              var dbObject = {}, updateParams;
              updateParams = queryObject._update["$set"] ? queryObject._update["$set"] : queryObject._update;
              Object.keys(updateParams).forEach(function(key) {
                  dbObject[key] = selfObject[key];
              });

              saveDiffObject(currentObject, dbObject, updateParams, queryObject.options.__user, queryObject.options.__reason, function(){
                  callback();
              });
          }
      }
    )
};

var saveDiffs = function(self, next) {
    var queryObject = self;
    queryObject.find(queryObject._conditions, function (err, results) {
        if (err) {
            err.message = "Mongo Error :" + err.message;
            return next();
        }

        async.eachSeries(results, function (result, callback) {
            if (err) {
                err.message = "Mongo Error :" + err.message;
                return next();
            }

            saveDiffHistory(queryObject, result, callback);
        }, function done() {
            return next();
        });
    });
};

var getVersion = function (model, id, version, callback) {
    model.findOne({_id: id}, function (err, latest) {
        if (err) {
            console.error(err);
            return callback(err, null);
        }
        History.find({collectionName: model.modelName, collectionId: id, version: {$gte : parseInt(version, 10)}},
            {diff: 1, version: 1}, {sort: "-version"}, function (err, histories) {
                if (err) {
                    console.error(err);
                    return callback(err, null);
                }
                var object = latest ? latest : {};
                async.each(histories, function(history, eachCallback){
                    jsondiffpatch.unpatch(object, history.diff);
                    eachCallback();
                }, function(err){
                    if (err) {
                        console.error(err);
                        return callback(err, null);
                    }
                    callback(null, object);
                });
            })
    });
};

var getHistories = function (modelName, id, skip, limit, callback) {
    History.find({collectionName: modelName, collectionId: id}).sort({ 'diff.updatedOn.1': -1, 'diff.updatedOn.0': -1 }).skip(Number(skip)).limit(Number(limit)).exec(function (err, histories) {

        if (err) {
            console.error(err);
            return callback(err, null);
        }
        async.map(histories, function (history, mapCallback) {
            var changedValues = [];
            var changedFields = [];

            var date = history.diff['updatedOn'][1] || history.diff['updatedOn'][0]
            var d = moment(date);
            var datetime =`: ${d.fromNow()}`;
            for (var key in history.diff) {
                if (history.diff.hasOwnProperty(key)) {

                      // if ('updatedOn' !== key) {
                        if(history.diff[key][0]) {
                          var oldValue = history.diff[key][0];
                          var newValue = history.diff[key][1];

                          changedValues.push(`${key} จาก \"${JSON.stringify(oldValue)}\" เป็น \"${JSON.stringify(newValue)}\" ${datetime}`);
                        } else {
                          changedValues.push(`${key} เป็น \"${JSON.stringify(history.diff[key])}\" ${datetime}`);
                        }
                      // }

                }
            }

            var comment =  `${history.user && history.user.hasOwnProperty('email')?history.user.email:history.user}`+" แก้ " + changedFields.concat(changedValues).join(", ");
            return mapCallback(null, {
                changedBy: history.user,
                changedAt: history.createdAt,
                updatedAt: history.updatedAt,
                reason: history.reason,
                comment: comment
            })
        }, function (err, output) {
            if (err) {
                console.error(err);
                return callback(err, null);
            }
            return callback(null, output);
        });
    });
};

var plugin = function lastModifiedPlugin(schema, options) {

    schema.pre("save", function (next) {

        var self = this;
        if(self.isNew) {
            next();
        }else{
            self.constructor.findOne({_id: self._id}, function (err, original) {
                saveDiffObject(self, original, self, self.__user, self.__reason, function(){
                    next();
                });
            });
        }
    });

    schema.pre("findOneAndUpdate", function (next) {
        saveDiffs(this, function(){
            next();
        });
    });

    schema.pre("update", function (next) {

        saveDiffs(this, function(){
            next();
        });
    });

    schema.pre("remove", function(next) {

        saveDiffObject(this, this, {}, this.__user, this.__reason, function(){
            next();
        })
    });
};

module.exports.plugin = plugin;
module.exports.getHistories = getHistories;
module.exports.getVersion = getVersion;
