'use strict';

var fs = require('fs');
var Mustache = require('mustache');
var beautify = require('js-beautify').js_beautify;
var lint = require('jshint').JSHINT;
var _ = require('lodash');
var ts = require('./typescript');

var defaultSuccessfulResponseType = 'void';

var normalizeName = function(id) {
  return id.replace(/\.|\-|\{|\}/g, '_');
};

/**
 * Converts a name to a type name without dots and to uppercase
 * @param {*} id 
 */
var normalizeNameToSafeType = function(id) {
  let name = _.camelCase(id.replace(/\.|\-|\{|\}/g, '_'));
  return name.charAt(0).toUpperCase() + name.slice(1);
};

/**
 * Generates the import of types string
 * @param {*} typesToImport 
 */
var formatTypesToImport = function(typesToImportObj) {
  const ignoreTypes = ['object', 'void', 'string'];
  const typesArr = Object.keys(typesToImportObj)
    .filter(t => ignoreTypes.indexOf(t) === -1) //  t !== 'object'
    .map(x => x);
  return `import { ${typesArr.join(', ')} } from './types';`;
};

var cleanType = function(typeToClean) {
  let cleanType = typeToClean.replace(/Array</g, "");
  cleanType = cleanType.replace(/>/g, "");
  return cleanType;
};

var getPathToMethodName = function(opts, m, path) {
  if (path === '/' || path === '') {
    return m;
  }

  // clean url path for requests ending with '/'
  var cleanPath = path.replace(/\/$/, '');

  var segments = cleanPath.split('/').slice(1);
  segments = _.transform(segments, function(result, segment) {
    if (segment[0] === '{' && segment[segment.length - 1] === '}') {
      segment = 'by' + segment[1].toUpperCase() + segment.substring(2, segment.length - 1);
    }
    result.push(segment);
  });


  var result = _.camelCase(segments.join('-'));
  return m.toLowerCase() + result[0].toUpperCase() + result.substring(1);
};

var getViewForSwagger2 = function(opts) {
  var swagger = opts.swagger;
  var authorizedMethods = ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'COPY', 'HEAD', 'OPTIONS', 'LINK', 'UNLIK', 'PURGE', 'LOCK', 'UNLOCK', 'PROPFIND'];
  var data = {
    isES6: opts.isES6,
    description: swagger.info.description,
    isSecure: swagger.securityDefinitions !== undefined,
    moduleName: opts.moduleName,
    className: opts.className,
    imports: opts.imports,
    domain: (swagger.schemes && swagger.schemes.length > 0 && swagger.host && swagger.basePath) ? swagger.schemes[0] + '://' + swagger.host + swagger.basePath.replace(/\/+$/g, '') : '',
    basePath: swagger.basePath,
    methods: [],
    definitions: [],
    typesToImportObj: {},
    typesToImport: ''
  };

  _.forEach(swagger.paths, function(api, path) {
    var globalParams = [];
    /**
     * @param {Object} op - meta data for the request
     * @param {string} m - HTTP method name - eg: 'get', 'post', 'put', 'delete'
     */
    _.forEach(api, function(op, m) {
      if (m.toLowerCase() === 'parameters') {
        globalParams = op;
      }
    });
    _.forEach(api, function(op, m) {
      var M = m.toUpperCase();

      if (M === '' || authorizedMethods.indexOf(M) === -1) {
        return;
      }

      var secureTypes = [];
      if (swagger.securityDefinitions !== undefined || op.security !== undefined) {
        var mergedSecurity = _.merge([], swagger.security, op.security).map(function(security) {
          return Object.keys(security);
        });
        if (swagger.securityDefinitions) {
          for (var sk in swagger.securityDefinitions) {
            if (mergedSecurity.join(',').indexOf(sk) !== -1) {
              secureTypes.push(swagger.securityDefinitions[sk].type);
            }
          }
        }
      }

      // the return type
      var successfulResponseType;
      try {
        const convertedType = ts.convertType(op.responses['200']);
        successfulResponseType = convertedType.target || convertedType.tsType || defaultSuccessfulResponseType;
      } catch (error) {
        successfulResponseType = defaultSuccessfulResponseType;
      }

      var method = {
        path: path,
        pathFormatString: path.replace(/{/g, '${parameters.'),
        className: opts.className,
        methodName: op.operationId ? normalizeName(op.operationId) : getPathToMethodName(opts, m, path),
        method: M,
        isGET: M === 'GET',
        isPOST: M === 'POST',
        summary: op.description || op.summary,
        externalDocs: op.externalDocs,
        isSecure: swagger.security !== undefined || op.security !== undefined,
        isSecureToken: secureTypes.indexOf('oauth2') !== -1,
        isSecureApiKey: secureTypes.indexOf('apiKey') !== -1,
        isSecureBasic: secureTypes.indexOf('basic') !== -1,
        parameters: [],
        headers: [],
        successfulResponseType: successfulResponseType
      };

      if (method.isSecure && method.isSecureToken) {
        data.isSecureToken = method.isSecureToken;
      }
      if (method.isSecure && method.isSecureApiKey) {
        data.isSecureApiKey = method.isSecureApiKey;
      }
      if (method.isSecure && method.isSecureBasic) {
        data.isSecureBasic = method.isSecureBasic;
      }
      var produces = op.produces || swagger.produces;
      if (produces) {
        method.headers.push({
          name: 'Accept',
          value: `'${produces.map(function(value) { return value; }).join(', ')}'`,
        });
      }

      var consumes = op.consumes || swagger.consumes;
      if (consumes) {
        var preferredContentType = consumes[0] || '';
        method.headers.push({ name: 'Content-Type', value: '\'' + preferredContentType + '\'' });
      }
      
      var params = [];
      if (_.isArray(op.parameters)) {
        params = op.parameters;
      }
      params = params.concat(globalParams);
      _.forEach(params, function(parameter) {
        //Ignore parameters which contain the x-exclude-from-bindings extension
        if (parameter['x-exclude-from-bindings'] === true) {
          return;
        }

        // Ignore headers which are injected by proxies & app servers
        // eg: https://cloud.google.com/appengine/docs/go/requests#Go_Request_headers
        if (parameter['x-proxy-header']) {
          return;
        }
        if (_.isString(parameter.$ref)) {
          var segments = parameter.$ref.split('/');
          parameter = swagger.parameters[segments.length === 1 ? segments[0] : segments[2]];
        }
        parameter.camelCaseName = _.camelCase(parameter.name);
        if (parameter.enum && parameter.enum.length === 1) {
          parameter.isSingleton = true;
          parameter.singleton = parameter.enum[0];
        }
        if (parameter.in === 'body') {
          parameter.isBodyParameter = true;
        } else if (parameter.in === 'path') {
          parameter.isPathParameter = true;
        } else if (parameter.in === 'query') {
          if (parameter['x-name-pattern']) {
            parameter.isPatternType = true;
            parameter.pattern = parameter['x-name-pattern'];
          }
          parameter.isQueryParameter = true;
        } else if (parameter.in === 'header') {
          parameter.isHeaderParameter = true;
        } else if (parameter.in === 'formData') {
          parameter.isFormParameter = true;
        }
        parameter.tsType = ts.convertType(parameter);
        parameter.cardinality = parameter.required ? '' : '?';
        method.parameters.push(parameter);
      });

      // check if we have options to only generate for a specifc path
      if (opts.generateForPath) {
        // add the type to the types to import
        if (method.path.length > 0) {
          const pathArr = method.path.slice(1).split('/');
          if (pathArr[0].toLowerCase() === opts.generateForPath.toLowerCase()) {
            data.methods.push(method);

            const params = method.parameters.forEach(x => {
              if (x.tsType.target) {
                const cleanedType = cleanType(x.tsType.target);
                data.typesToImportObj[cleanedType] = cleanedType;
              }
            });

            data.typesToImportObj[cleanType(method.successfulResponseType)] = cleanType(method.successfulResponseType);
          }
        }
      } else {
        data.methods.push(method);
      }
    });
  });

  _.forEach(swagger.definitions, function(definition, name) {
    data.definitions.push({
      name: normalizeNameToSafeType(name),
      description: definition.description,
      tsType: ts.convertType(definition, swagger)
    });
  });
  // add the default types to import
  data.typesToImport = formatTypesToImport(data.typesToImportObj);

  return data;
};

var getCode = function(opts, type) {
  if (opts.swagger.swagger !== '2.0') {
    throw new Error('Only Swagger 2 specs are supported');
  }

  var data = getViewForSwagger2(opts, type);
  if (type === 'custom') {
    if (!_.isObject(opts.template) || !_.isString(opts.template.class) || !_.isString(opts.template.method)) {
      throw new Error('Unprovided custom template. Please use the following template: template: { class: "...", method: "...", request: "..." }');
    }
  } else {
    if (!_.isObject(opts.template)) {
      opts.template = {};
    }
    var templates = __dirname + '/../templates/';

    // check output options on how and what to generate
    if (opts.outputType && opts.outputType === 'TYPES') {
      opts.template.typesWrapper = opts.template.typesWrapper || fs.readFileSync(templates + 'typesWrapper.mustache', 'utf-8');
    }
    else if (opts.outputType && opts.outputType === 'CLASS') {
      opts.template.classWrapper = opts.template.classWrapper || fs.readFileSync(templates + 'classWrapperFunctions.mustache', 'utf-8');
    }
    else {
      opts.template.class = opts.template.class || fs.readFileSync(templates + 'class.mustache', 'utf-8');
      opts.template.method = opts.template.method || fs.readFileSync(templates + 'method.mustache', 'utf-8');
      opts.template.type = opts.template.type || fs.readFileSync(templates + 'type.mustache', 'utf-8');
    }
  }

  if (opts.mustache) {
    _.assign(data, opts.mustache);
  }

  // Ensure we don't encode special characters
  Mustache.escape = (value) => value;
  var source = '';
  if (opts.outputType && opts.outputType === 'TYPES') {
    source = Mustache.render(opts.template.typesWrapper, data, opts.template);
  }
  else if (opts.outputType && opts.outputType === 'CLASS') {
    source = Mustache.render(opts.template.classWrapper, data, opts.template);
  }
  else {
    source = Mustache.render(opts.template.class, data, opts.template);
  }

  var lintOptions = {
    browser: type === 'custom',
    undef: true,
    strict: true,
    trailing: false,
    smarttabs: true,
    maxerr: 999
  };

  if (opts.esnext) {
    lintOptions.esnext = true;
  }

  if (opts.lint === true) {
    lint(source, lintOptions);
    lint.errors.forEach(function(error) {
      if (error.code[0] === 'E') {
        throw new Error(error.reason + ' in ' + error.evidence + ' (' + error.code + ')');
      }
    });
  }

  if (opts.beautify === undefined || opts.beautify === true) {
    var beautifyOptions = _.defaults(opts.beautifyOptions || {}, { indent_size: 2, max_preserve_newlines: 2 });
    return beautify(source, beautifyOptions);
  } else {
    return source;
  }
};

exports.CodeGen = {
  getTypescriptCode: function(opts) {
    return getCode(opts, 'typescript');
  },
  getCustomCode: function(opts) {
    return getCode(opts, 'custom');
  }
};

