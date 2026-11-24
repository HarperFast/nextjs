export const metadata = {
	title: 'Harper - Next.js App With a basePath Matching Its Mount',
};

export default function RootLayout({ children }) {
	return (
		<html>
			<body>{children}</body>
		</html>
	);
}
