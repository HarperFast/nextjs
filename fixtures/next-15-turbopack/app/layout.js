export const metadata = {
	title: 'Harper - Next.js v15 App',
};

export default function RootLayout({ children }) {
	return (
		<html>
			<body>{children}</body>
		</html>
	);
}
