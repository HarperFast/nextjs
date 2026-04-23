module.exports = {
	webpack: (config) => {
		config.externals.push({
			harperdb: 'commonjs harperdb',
		});

		return config;
	},
};
